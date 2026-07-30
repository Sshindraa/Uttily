import { and, eq, exists, inArray, isNull, not, sql } from 'drizzle-orm';
import {
  allocations,
  bookingDraftLines,
  bookingDrafts,
  inventoryBlocks,
  inventoryItems,
  locations,
  organizations,
  products,
  productVariants,
  users,
  type DatabaseClient,
  type DatabaseTransaction,
} from '@uttily/database';
import { isActionErrorCode } from '@uttily/contracts';
import { completeKey, computeFingerprint, failKey, lockKey, reserveKey } from '../idempotency';
import type { IdempotentPayload } from '../idempotency';
import { calculateBillableCivilDays } from '../pricing/civil-days';
import { calculatePrice } from '../pricing/calculate-price';
import { PricingError } from '../pricing/errors';
import type { PricingLineInput, VariantPricingSnapshot } from '../pricing/types';
import { BookingDraftError } from './errors';
import type {
  BookingDraftAllocation,
  BookingDraftFailureBody,
  BookingDraftResponseBody,
  CreateBookingDraftFailure,
  CreateBookingDraftInput,
  CreateBookingDraftResult,
  CreateBookingDraftSuccess,
} from './types';

/**
 * @uttily/core — Création atomique et idempotente d'un brouillon de réservation
 * mono-loueur (Lot 4, étape 4).
 *
 * `createBookingDraftWithHold` est une primitive de haut niveau qui :
 * - valide l'entrée (étape A) ;
 * - calcule l'empreinte et réserve la clé d'idempotence (étape B) ;
 * - exécute la logique métier dans une transaction externe unique avec
 *   savepoint manuel (étape C) : chargement du catalogue, calcul du prix,
 *   allocation déterministe d'exemplaires, création des blocs HOLD et
 *   allocations, persistance idempotente du résultat.
 *
 * Le client ne fournit JAMAIS : prix, devise, taxes, commission, fuseau,
 * marges, snapshots, politique d'annulation.
 */

/** Nom de l'opération idempotente (ADR-009). */
const CREATE_BOOKING_DRAFT_OPERATION = 'create_booking_draft';

/** Version du snapshot de politique d'annulation (ADR-009). */
const CANCELLATION_POLICY_SNAPSHOT_VERSION = 'v1';

/** Durée du hold en minutes (ADR-009). */
const HOLD_DURATION_MINUTES = 10;

/**
 * Ligne agrégée canonique (variantId → quantité totale).
 * Les lignes en doublon sont fusionnées avant le calcul de l'empreinte.
 */
interface AggregatedLine {
  variantId: string;
  quantity: number;
}

/**
 * Données catalogue chargées pour une variante agrégée.
 */
interface VariantCatalogData {
  variant: typeof productVariants.$inferSelect;
  product: typeof products.$inferSelect;
  snapshot: VariantPricingSnapshot;
}

/** Vérifie et décode centralement un corps de succès idempotent persisté. */
function decodeSuccessBody(body: unknown): BookingDraftResponseBody {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('draftId' in body) ||
    typeof body.draftId !== 'string' ||
    !('status' in body) ||
    body.status !== 'HELD'
  ) {
    throw new BookingDraftError('UNKNOWN', 'Réponse idempotente de succès invalide.');
  }
  return body as BookingDraftResponseBody;
}

/** Vérifie et décode centralement un corps d'échec idempotent persisté. */
function decodeFailureBody(body: unknown): BookingDraftFailureBody {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('error' in body) ||
    !isActionErrorCode(body.error) ||
    !('message' in body) ||
    typeof body.message !== 'string'
  ) {
    throw new BookingDraftError('UNKNOWN', "Réponse idempotente d'échec invalide.");
  }
  return body as BookingDraftFailureBody;
}

/**
 * Extrait la réponse persistée d'un enregistrement idempotent terminal et
 * construit le bon membre de l'union selon son statut persistant.
 */
function extractReplayResult(record: {
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  responseStatusCode: number | null;
  responseBody: unknown;
  resourceId: string | null;
}): CreateBookingDraftResult {
  if (record.status === 'PENDING') {
    throw new BookingDraftError('UNKNOWN', 'Enregistrement idempotent encore PENDING au replay.');
  }
  if (record.status === 'COMPLETED') {
    if (record.responseStatusCode !== 201 || record.resourceId === null) {
      throw new BookingDraftError('UNKNOWN', 'Enregistrement idempotent COMPLETED invalide.');
    }
    return {
      kind: 'SUCCESS',
      statusCode: 201,
      body: decodeSuccessBody(record.responseBody),
      resourceId: record.resourceId,
    };
  }

  if (
    record.responseStatusCode !== 400 &&
    record.responseStatusCode !== 404 &&
    record.responseStatusCode !== 409
  ) {
    throw new BookingDraftError('UNKNOWN', 'Enregistrement idempotent FAILED invalide.');
  }
  return {
    kind: 'FAILURE',
    statusCode: record.responseStatusCode,
    resourceId: null,
    body: decodeFailureBody(record.responseBody),
  };
}

/**
 * Détecte une violation de contrainte d'exclusion PostgreSQL (SQLSTATE 23P01).
 *
 * Exige qu'au moins un des champs `constraint_name` ou `constraint` corresponde
 * exactement au nom de la contrainte attendue, afin d'éviter de capturer une
 * 23P01 provenant d'une autre contrainte d'exclusion.
 */
function isExclusionViolation(err: unknown, constraintName: string): boolean {
  let current: unknown = err;
  while (typeof current === 'object' && current !== null) {
    const pgErr = current as {
      code?: string;
      constraint_name?: string;
      constraint?: string;
      cause?: unknown;
    };
    if (pgErr.code === '23P01') {
      const name = pgErr.constraint_name ?? pgErr.constraint;
      if (name === constraintName) return true;
    }
    if (pgErr.cause === current) break;
    current = pgErr.cause;
  }
  return false;
}

/** Traduit les erreurs métier attendues avant leur persistance idempotente. */
function normalizeBusinessError(error: unknown): BookingDraftError | null {
  if (error instanceof BookingDraftError) return error;
  if (error instanceof PricingError) {
    return new BookingDraftError('VALIDATION', error.message, {
      responseBody: {
        error: 'VALIDATION',
        message: error.message,
        details: { pricingErrorCode: error.code },
      },
    });
  }
  if (isExclusionViolation(error, 'no_overlapping_blocks')) {
    return new BookingDraftError(
      'CONFLICT_BLOCK',
      'Conflit de disponibilité : un blocage existe déjà sur cette période.',
      { statusCode: 409 },
    );
  }
  return null;
}

/**
 * Crée atomiquement un brouillon de réservation mono-loueur avec calcul du
 * prix, allocation d'exemplaires, création de holds et persistance idempotente
 * du résultat.
 *
 * @param db client base de données (DatabaseClient)
 * @param input entrée sémantique fournie par le client
 * @returns résultat (union discriminée SUCCESS | FAILED) — 201 en cas de
 *   succès, 4xx en cas d'erreur métier persistée.
 */
export async function createBookingDraftWithHold(
  db: DatabaseClient,
  input: CreateBookingDraftInput,
): Promise<CreateBookingDraftResult> {
  // ── Étape A — Validation initiale (avant la base) ──────────────────────
  validateInput(input);

  // Agrégation canonique : fusionner les lignes ayant le même variantId.
  const aggregatedLines = aggregateLines(input.lines);

  // ── Étape A2 — Prévalidation de l'organisation (avant reserveKey) ──────
  // reserveKey insère dans idempotency_records qui a une FK vers organizations.
  // Un UUID d'organisation inexistant échouerait avant le savepoint avec une
  // erreur PostgreSQL brute (violation FK). On prévalide ici pour renvoyer une
  // erreur métier propre (NOT_FOUND) sans créer d'enregistrement idempotent.
  // Le format UUID est déjà validé par validateInput (étape A), donc un UUID
  // mal formé lève une erreur VALIDATION avant d'atteindre cette lecture.
  // Note : cette lecture courte hors transaction ne garantit pas que l'org
  // existe encore au moment de la transaction (TOCTOU), mais protège contre
  // les erreurs FK brutes pour les UUID inexistants.
  // La validation complète (devise EUR, politique) reste dans la transaction.
  const orgExists = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1);

  if (orgExists.length === 0) {
    throw new BookingDraftError('NOT_FOUND', 'Organisation introuvable.', {
      statusCode: 404,
      responseBody: { error: 'NOT_FOUND', message: 'Organisation introuvable.' },
    });
  }

  // ── Étape B — Calcul de l'empreinte et reserveKey ──────────────────────
  const payload: IdempotentPayload = {
    organizationId: input.organizationId,
    locationId: input.locationId,
    customerUserId: input.customerUserId,
    customerStartAt: input.customerStartAt,
    customerEndAt: input.customerEndAt,
    lines: aggregatedLines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
  };
  const fingerprint = computeFingerprint(payload);

  const reservation = await reserveKey(db, {
    organizationId: input.organizationId,
    operation: CREATE_BOOKING_DRAFT_OPERATION,
    key: input.idempotencyKey,
    requestFingerprint: fingerprint,
  });

  if (reservation.kind === 'REPLAY') {
    return extractReplayResult(reservation.record);
  }
  if (reservation.kind === 'CONFLICT') {
    throw new BookingDraftError(
      'CONFLICT_IDEMPOTENCY',
      "Clé d'idempotence réutilisée avec un payload différent.",
      { statusCode: 409 },
    );
  }
  // ACQUIRED ou PENDING → continuer vers la transaction.

  // ── Étape C — Transaction externe unique avec savepoint imbriqué ──────
  //
  // ADR-009 §11 étape 4 : les erreurs métier prévues sont capturées dans un
  // SAVEPOINT de la transaction externe qui conserve le verrou sur
  // l'enregistrement PENDING. Le savepoint est annulé (ROLLBACK TO SAVEPOINT),
  // puis l'enregistrement est mis à jour en FAILED, et la transaction externe
  // est committée. Le verrou sur la ligne PENDING est conservé pendant toute
  // l'opération, empêchant toute course concurrente.
  //
  // Une panne ou erreur SQL non récupérable laisse l'enregistrement PENDING.
  // Aucune écriture FAILED après rollback de la transaction principale.
  //
  // Le savepoint est créé via `tx.transaction()` (transaction imbriquée Drizzle)
  // qui délègue à `postgres.js savepoint()`. Ce mécanisme garantit que le
  // ROLLBACK TO SAVEPOINT est exécuté automatiquement par le driver en cas
  // d'erreur, et que la transaction externe reste utilisable ensuite pour
  // `failKey` ou `completeKey`. L'utilisation de commandes SAVEPOINT manuelles
  // via `tx.execute(sql\`SAVEPOINT ...\`)` est incompatible avec le driver
  // postgres.js qui traque les erreurs non rattrapées et provoque un rollback
  // complet de la transaction externe.
  return await db.transaction(async (tx) => {
    const lock = await lockKey(tx, reservation.record.id);
    if (lock.kind === 'REPLAY') {
      return extractReplayResult(lock.record);
    }
    // LOCKED : exécuter la logique métier dans un savepoint imbriqué.
    let businessResult: CreateBookingDraftSuccess;
    try {
      businessResult = await tx.transaction(async (sp) => {
        return await executeBusinessLogic(sp, input, aggregatedLines);
      });
    } catch (error) {
      // Le savepoint a été automatiquement annulé par postgres.js.
      // La transaction externe (tx) est intacte et le verrou idempotent est
      // conservé : on peut persister l'échec métier via failKey.
      const bookingDraftError = normalizeBusinessError(error);
      if (bookingDraftError === null) {
        // Erreur technique inattendue : rollback complet, idempotency reste PENDING.
        throw error;
      }

      await failKey(tx, reservation.record.id, {
        responseStatusCode: bookingDraftError.statusCode,
        responseBody: bookingDraftError.responseBody,
      });
      const failure: CreateBookingDraftFailure = {
        kind: 'FAILURE',
        statusCode: bookingDraftError.statusCode,
        resourceId: null,
        body: bookingDraftError.responseBody,
      };
      return failure;
    }

    // Le savepoint a été validé (RELEASE automatique par postgres.js).
    // completeKey s'exécute dans la transaction externe. Toute erreur ici
    // provoque le rollback complet et laisse la clé PENDING.
    await completeKey(tx, reservation.record.id, {
      resourceId: businessResult.resourceId,
      responseStatusCode: businessResult.statusCode,
      responseBody: businessResult.body,
    });
    return businessResult;
  });
}

/**
 * Valide le format canonique d'un UUID (8-4-4-4-12 hex).
 * Évite une erreur PostgreSQL brute (SQLSTATE 22P02) lors des requêtes typées.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateUuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) {
    throw new BookingDraftError('VALIDATION', `${field} doit être un UUID valide.`);
  }
}

/**
 * Valide l’entrée avant toute interaction avec la base.
 * @throws BookingDraftError('VALIDATION') si une contrainte n'est pas respectée.
 */
function validateInput(input: CreateBookingDraftInput): void {
  if (!input.organizationId || input.organizationId.length === 0) {
    throw new BookingDraftError('VALIDATION', 'organizationId est requis.');
  }
  validateUuid(input.organizationId, 'organizationId');
  if (!input.locationId || input.locationId.length === 0) {
    throw new BookingDraftError('VALIDATION', 'locationId est requis.');
  }
  validateUuid(input.locationId, 'locationId');
  if (!input.customerUserId || input.customerUserId.length === 0) {
    throw new BookingDraftError('VALIDATION', 'customerUserId est requis.');
  }
  validateUuid(input.customerUserId, 'customerUserId');
  if (!input.idempotencyKey || input.idempotencyKey.length === 0) {
    throw new BookingDraftError('VALIDATION', 'idempotencyKey est requis.');
  }
  if (!Number.isFinite(input.customerStartAt.getTime())) {
    throw new BookingDraftError('VALIDATION', 'customerStartAt est une date invalide.');
  }
  if (!Number.isFinite(input.customerEndAt.getTime())) {
    throw new BookingDraftError('VALIDATION', 'customerEndAt est une date invalide.');
  }
  if (!(input.customerEndAt.getTime() > input.customerStartAt.getTime())) {
    throw new BookingDraftError(
      'VALIDATION',
      'La période doit être strictement positive (customerEndAt > customerStartAt).',
    );
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new BookingDraftError('VALIDATION', 'Au moins une ligne est requise.');
  }
  for (const [i, line] of input.lines.entries()) {
    if (!line.variantId || line.variantId.length === 0) {
      throw new BookingDraftError('VALIDATION', `lines[${i}].variantId est requis.`);
    }
    validateUuid(line.variantId, `lines[${i}].variantId`);
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new BookingDraftError(
        'VALIDATION',
        `lines[${i}].quantity doit être un entier strictement positif.`,
      );
    }
  }
}

/**
 * Fusionne les lignes ayant le même variantId (somme des quantités).
 * @throws BookingDraftError('VALIDATION') si la somme dépasse Number.MAX_SAFE_INTEGER.
 */
function aggregateLines(lines: CreateBookingDraftInput['lines']): AggregatedLine[] {
  const map = new Map<string, number>();
  for (const line of lines) {
    const current = map.get(line.variantId) ?? 0;
    const sum = current + line.quantity;
    if (!Number.isSafeInteger(sum)) {
      throw new BookingDraftError(
        'VALIDATION',
        `La quantité agrégée pour la variante ${line.variantId} dépasse Number.MAX_SAFE_INTEGER.`,
      );
    }
    map.set(line.variantId, sum);
  }
  return [...map.entries()].map(([variantId, quantity]) => ({ variantId, quantity }));
}

/**
 * Logique métier principale, exécutée dans la transaction après le savepoint.
 *
 * @throws BookingDraftError pour les erreurs métier attendues.
 * @throws Error pour les erreurs techniques (rollback complet).
 */
async function executeBusinessLogic(
  tx: DatabaseTransaction,
  input: CreateBookingDraftInput,
  aggregatedLines: AggregatedLine[],
): Promise<CreateBookingDraftSuccess> {
  // 1. Charger et valider l'organisation.
  // La prévalidation avant reserveKey évite une violation FK non typée ; cette relecture transactionnelle ferme le TOCTOU et assure la cohérence de la mutation, et si l'organisation disparaît entre les deux, le savepoint renvoie une erreur métier.
  const org = await tx
    .select()
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1);
  if (org.length === 0) {
    throw new BookingDraftError('NOT_FOUND', 'Organisation introuvable.');
  }
  if (org[0]!.defaultCurrency !== 'EUR') {
    throw new BookingDraftError('VALIDATION', 'Devise non supportée au MVP.');
  }
  const policyCode = org[0]!.defaultCancellationPolicyCode;

  // 2. Charger et valider le lieu.
  const loc = await tx
    .select()
    .from(locations)
    .where(and(eq(locations.id, input.locationId), isNull(locations.deletedAt)))
    .limit(1);
  if (loc.length === 0) {
    throw new BookingDraftError('NOT_FOUND', 'Lieu introuvable.');
  }
  if (loc[0]!.organizationId !== input.organizationId) {
    throw new BookingDraftError('VALIDATION', "Le lieu n'appartient pas à l'organisation.");
  }
  const timeZone = loc[0]!.timeZone;
  const prepBufferMinutes = loc[0]!.prepBufferMinutes;
  const cleanupBufferMinutes = loc[0]!.cleanupBufferMinutes;

  // 3. Valider l'utilisateur.
  const user = await tx
    .select()
    .from(users)
    .where(and(eq(users.id, input.customerUserId), isNull(users.deletedAt)))
    .limit(1);
  if (user.length === 0) {
    throw new BookingDraftError('NOT_FOUND', 'Utilisateur introuvable.');
  }

  // 4. Charger et valider le catalogue (pour chaque variante agrégée).
  const variantDataMap = new Map<string, VariantCatalogData>();
  for (const line of aggregatedLines) {
    const variantData = await tx
      .select({ variant: productVariants, product: products })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(
        and(
          eq(productVariants.id, line.variantId),
          eq(products.organizationId, input.organizationId),
        ),
      )
      .limit(1);

    if (variantData.length === 0) {
      throw new BookingDraftError('NOT_FOUND', `Variante ${line.variantId} introuvable.`);
    }

    const { variant, product } = variantData[0]!;

    if (product.publicationStatus !== 'PUBLISHED') {
      throw new BookingDraftError('VALIDATION', `Produit ${product.name} non publié.`);
    }
    if (product.deletedAt !== null) {
      throw new BookingDraftError('NOT_FOUND', `Produit ${product.name} supprimé.`);
    }
    if (!variant.isActive) {
      throw new BookingDraftError('VALIDATION', `Variante ${variant.name} inactive.`);
    }
    if (variant.deletedAt !== null) {
      throw new BookingDraftError('NOT_FOUND', `Variante ${variant.name} supprimée.`);
    }
    if (variant.dailyPriceAmountMinor === null || variant.dailyPriceAmountMinor <= 0) {
      throw new BookingDraftError('VALIDATION', `Variante ${variant.name} sans prix valide.`);
    }
    if (variant.currency !== 'EUR') {
      throw new BookingDraftError('VALIDATION', `Variante ${variant.name} : devise non EUR.`);
    }
    if (!Number.isSafeInteger(variant.dailyPriceAmountMinor)) {
      throw new BookingDraftError(
        'VALIDATION',
        `Variante ${variant.name} : prix hors plage safe integer.`,
      );
    }

    variantDataMap.set(line.variantId, {
      variant,
      product,
      snapshot: {
        productName: product.name,
        variantName: variant.name,
        skuSuffix: variant.skuSuffix,
        attributes: variant.attributes as Record<string, unknown>,
      },
    });
  }

  // 5. Calculer les jours civils.
  const billableDayCount = calculateBillableCivilDays(
    input.customerStartAt,
    input.customerEndAt,
    timeZone,
  );

  // 6. Calculer le prix.
  const pricingLines: PricingLineInput[] = aggregatedLines.map((l) => {
    const vd = variantDataMap.get(l.variantId)!;
    return {
      variantId: l.variantId,
      unitPriceAmountMinor: vd.variant.dailyPriceAmountMinor!,
      quantity: l.quantity,
      currency: 'EUR',
      variantSnapshot: vd.snapshot,
    };
  });
  const pricingResult = calculatePrice(pricingLines, billableDayCount);

  // 7. Calculer la période bloquée puis sélectionner/verrouiller tous les
  // exemplaires avant de créer la moindre ressource métier (ADR-009).
  const blockedStartAt = new Date(input.customerStartAt.getTime() - prepBufferMinutes * 60 * 1000);
  const blockedEndAt = new Date(input.customerEndAt.getTime() + cleanupBufferMinutes * 60 * 1000);
  const sortedPricingLines = [...pricingResult.lines].sort((a, b) =>
    a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0,
  );
  const selectedItemsByVariant = new Map<
    string,
    Array<{ id: string; internalSku: string; productVariantId: string }>
  >();

  for (const pricingLine of sortedPricingLines) {
    const eligibleItems = await tx
      .select({
        id: inventoryItems.id,
        internalSku: inventoryItems.internalSku,
        productVariantId: inventoryItems.productVariantId,
      })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.organizationId, input.organizationId),
          eq(inventoryItems.currentLocationId, input.locationId),
          eq(inventoryItems.status, 'ACTIVE'),
          eq(inventoryItems.productVariantId, pricingLine.variantId),
          isNull(inventoryItems.deletedAt),
          inArray(inventoryItems.condition, ['NEW', 'GOOD', 'FAIR']),
          not(
            exists(
              tx
                .select({ one: inventoryBlocks })
                .from(inventoryBlocks)
                .where(
                  and(
                    eq(inventoryBlocks.inventoryItemId, inventoryItems.id),
                    inArray(inventoryBlocks.status, ['ACTIVE', 'PAYMENT_PROCESSING']),
                    isNull(inventoryBlocks.deletedAt),
                    sql`tstzrange(${inventoryBlocks.blockedStartAt}, ${inventoryBlocks.blockedEndAt}) && tstzrange(${blockedStartAt.toISOString()}, ${blockedEndAt.toISOString()})`,
                  ),
                ),
            ),
          ),
        ),
      )
      .orderBy(inventoryItems.productVariantId, inventoryItems.internalSku, inventoryItems.id)
      .for('update', { skipLocked: true })
      .limit(pricingLine.quantity);

    if (eligibleItems.length < pricingLine.quantity) {
      const message = `Stock insuffisant pour la variante ${pricingLine.variantId}: demandé ${pricingLine.quantity}, disponible ${eligibleItems.length}.`;
      throw new BookingDraftError('CONFLICT_BLOCK', message, {
        statusCode: 409,
        responseBody: {
          error: 'CONFLICT_BLOCK',
          message,
          details: {
            reason: 'INSUFFICIENT_STOCK',
            variantId: pricingLine.variantId,
            requested: pricingLine.quantity,
            available: eligibleItems.length,
          },
        },
      });
    }
    selectedItemsByVariant.set(pricingLine.variantId, eligibleItems);
  }

  // 8. Calculer une seule échéance avec l'horloge PostgreSQL.
  const expiresAtResult = await tx.execute(
    sql`SELECT (transaction_timestamp() + interval '${sql.raw(String(HOLD_DURATION_MINUTES))} minutes') AS expires_at`,
  );
  const rawExpiresAt = (expiresAtResult[0] as unknown as { expires_at: Date | string }).expires_at;
  const draftExpiresAt = rawExpiresAt instanceof Date ? rawExpiresAt : new Date(rawExpiresAt);

  // 9. Créer le brouillon HELD après la validation complète du stock.
  const insertedDraft = await tx
    .insert(bookingDrafts)
    .values({
      organizationId: input.organizationId,
      locationId: input.locationId,
      customerUserId: input.customerUserId,
      status: 'HELD',
      customerStartAt: input.customerStartAt,
      customerEndAt: input.customerEndAt,
      blockedStartAt,
      blockedEndAt,
      timezone: timeZone,
      prepBufferMinutes,
      cleanupBufferMinutes,
      currency: 'EUR',
      subtotalAmountMinor: pricingResult.subtotalAmountMinor,
      mandatoryFeesAmountMinor: pricingResult.mandatoryFeesAmountMinor,
      totalAmountMinor: pricingResult.totalAmountMinor,
      taxStatus: 'UNDETERMINED',
      taxAmountMinor: null,
      taxRateBps: null,
      commissionAmountMinor: null,
      billableUnit: 'DAY',
      billableUnitCount: pricingResult.billableUnitCount,
      cancellationPolicySnapshot: {
        policy_code: policyCode,
        policy_version: CANCELLATION_POLICY_SNAPSHOT_VERSION,
        timezone: timeZone,
      },
      expiresAt: draftExpiresAt,
    })
    .returning();
  const draftId = insertedDraft[0]!.id;

  // 10. Créer les lignes canoniques après le brouillon.
  const lineIdMap = new Map<string, string>();
  for (const pricingLine of sortedPricingLines) {
    const insertedLine = await tx
      .insert(bookingDraftLines)
      .values({
        draftId,
        variantId: pricingLine.variantId,
        quantity: pricingLine.quantity,
        unitPriceAmountMinor: pricingLine.unitPriceAmountMinor,
        billableUnitCount: pricingLine.billableUnitCount,
        lineTotalAmountMinor: pricingLine.lineTotalAmountMinor,
        currency: 'EUR',
        variantSnapshot: pricingLine.variantSnapshot,
      })
      .returning();
    lineIdMap.set(pricingLine.variantId, insertedLine[0]!.id);
  }

  // 11. Créer les HOLDs, puis les allocations correspondantes.
  const allAllocations: Array<BookingDraftAllocation & { variantId: string }> = [];
  for (const pricingLine of sortedPricingLines) {
    const lineId = lineIdMap.get(pricingLine.variantId)!;
    for (const item of selectedItemsByVariant.get(pricingLine.variantId)!) {
      const insertedBlock = await tx
        .insert(inventoryBlocks)
        .values({
          organizationId: input.organizationId,
          inventoryItemId: item.id,
          type: 'HOLD',
          status: 'ACTIVE',
          customerStartAt: input.customerStartAt,
          customerEndAt: input.customerEndAt,
          blockedStartAt,
          blockedEndAt,
          expiresAt: draftExpiresAt,
          sourceId: draftId,
        })
        .returning();
      const blockId = insertedBlock[0]!.id;
      const insertedAllocation = await tx
        .insert(allocations)
        .values({ draftLineId: lineId, inventoryBlockId: blockId, status: 'ALLOCATED' })
        .returning();

      allAllocations.push({
        variantId: pricingLine.variantId,
        allocationId: insertedAllocation[0]!.id,
        inventoryBlockId: blockId,
        inventoryItemId: item.id,
        internalSku: item.internalSku,
      });
    }
  }

  const response: BookingDraftResponseBody = {
    draftId,
    status: 'HELD',
    organizationId: input.organizationId,
    locationId: input.locationId,
    customerUserId: input.customerUserId,
    customerStartAt: input.customerStartAt.toISOString(),
    customerEndAt: input.customerEndAt.toISOString(),
    blockedStartAt: blockedStartAt.toISOString(),
    blockedEndAt: blockedEndAt.toISOString(),
    expiresAt: draftExpiresAt.toISOString(),
    currency: 'EUR',
    billableUnit: 'DAY',
    billableUnitCount: pricingResult.billableUnitCount,
    subtotalAmountMinor: pricingResult.subtotalAmountMinor,
    mandatoryFeesAmountMinor: pricingResult.mandatoryFeesAmountMinor,
    totalAmountMinor: pricingResult.totalAmountMinor,
    taxStatus: 'UNDETERMINED',
    taxAmountMinor: null,
    taxRateBps: null,
    commissionAmountMinor: null,
    cancellationPolicySnapshot: {
      policy_code: policyCode,
      policy_version: CANCELLATION_POLICY_SNAPSHOT_VERSION,
      timezone: timeZone,
    },
    lines: sortedPricingLines.map((pricingLine) => ({
      lineId: lineIdMap.get(pricingLine.variantId)!,
      variantId: pricingLine.variantId,
      quantity: pricingLine.quantity,
      unitPriceAmountMinor: pricingLine.unitPriceAmountMinor,
      billableUnitCount: pricingLine.billableUnitCount,
      lineTotalAmountMinor: pricingLine.lineTotalAmountMinor,
      currency: 'EUR',
      variantSnapshot: pricingLine.variantSnapshot,
      allocations: allAllocations
        .filter((allocation) => allocation.variantId === pricingLine.variantId)
        .map(({ variantId: _variantId, ...allocation }) => allocation),
    })),
  };

  return { kind: 'SUCCESS', statusCode: 201, body: response, resourceId: draftId };
}
