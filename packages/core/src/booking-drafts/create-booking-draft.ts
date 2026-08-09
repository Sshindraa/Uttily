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
import {
  completeKey,
  computeFingerprint,
  computeFlexibleFingerprint,
  failKey,
  lockKey,
  reserveKey,
} from '../idempotency';
import type {
  FlexibleIdempotentPayload,
  FlexibleIntentCanonical,
  IdempotentPayload,
} from '../idempotency';
import { calculateBillableCivilDays } from '../pricing/civil-days';
import { calculatePrice } from '../pricing/calculate-price';
import { PricingError } from '../pricing/errors';
import type { PricingLineInput, VariantPricingSnapshot } from '../pricing/types';
import { quoteFlexiblePricing } from '../pricing-plans/quote-flexible-pricing';
import { FlexiblePricingError } from '../pricing-plans/errors';
import {
  LocalToUtcError,
  localDateTimeToUtc,
  localDateTimeStringToUtc,
  parseLocalDateTimeString,
} from '../pricing-plans/local-to-utc';
import type { LocalDateTime } from '../pricing-plans/local-to-utc';
import { BookingDraftError } from './errors';
import type {
  BookingDraftAllocation,
  BookingDraftFailureBody,
  BookingDraftResponseBody,
  BookingDraftSuccessBody,
  CreateBookingDraftFailure,
  CreateBookingDraftInput,
  CreateBookingDraftResult,
  CreateBookingDraftSuccess,
  FlexibleBookingDraftIntent,
  FlexibleBookingDraftResponseBody,
  FlexibleBookingDraftResponseLine,
  FlexibleCreateBookingDraftInput,
  LegacyCreateBookingDraftInput,
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
function decodeSuccessBody(body: unknown): BookingDraftSuccessBody {
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
  // Détecter si c'est un corps flexible (présence de pricingSnapshotVersion = 'flexible-pricing-v1').
  if ('pricingSnapshotVersion' in body && body.pricingSnapshotVersion === 'flexible-pricing-v1') {
    return body as FlexibleBookingDraftResponseBody;
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
  if (error instanceof FlexiblePricingError) {
    // G7P-B2-B Round 2 — Defect 7 : PRICING_CONTEXT_UNAVAILABLE est une erreur
    // d'infrastructure (ex. PostgreSQL injoignable). Elle ne doit PAS être
    // persistée comme une erreur métier. On retourne null pour que l'erreur
    // brute soit relancée (conforme à ADR-009 : la clé reste en état d'erreur
    // technique, pas en état FAILED métier).
    if (error.code === 'PRICING_CONTEXT_UNAVAILABLE') {
      return null;
    }
    return normalizeFlexiblePricingError(error);
  }
  if (error instanceof LocalToUtcError) {
    return new BookingDraftError('VALIDATION', error.message, {
      responseBody: {
        error: 'VALIDATION',
        message: error.message,
        details: { localToUtcErrorCode: error.code },
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
 * Mappe un FlexiblePricingError vers un BookingDraftError.
 * Aucun fallback vers legacy : une erreur flexible est toujours une erreur.
 */
function normalizeFlexiblePricingError(error: FlexiblePricingError): BookingDraftError {
  switch (error.code) {
    case 'LOCATION_NOT_FOUND':
    case 'VARIANT_NOT_FOUND':
      return new BookingDraftError('NOT_FOUND', error.message, {
        statusCode: 404,
        responseBody: {
          error: 'NOT_FOUND',
          message: error.message,
          details: { pricingErrorCode: error.code },
        },
      });
    case 'PRODUCT_NOT_ELIGIBLE':
    case 'NO_ELIGIBLE_PLAN':
    case 'OUTSIDE_OPENING_HOURS':
    case 'PRICING_CONFIGURATION_INVALID':
    case 'UNSUPPORTED_LOCALE':
    case 'CURRENCY_MISMATCH':
    case 'AMOUNT_OVERFLOW':
    case 'VALIDATION':
      return new BookingDraftError('VALIDATION', error.message, {
        responseBody: {
          error: 'VALIDATION',
          message: error.message,
          details: { pricingErrorCode: error.code },
        },
      });
    case 'PRICING_CONTEXT_UNAVAILABLE':
      // G7P-B2-B Round 2 — Defect 7 : erreur d'infrastructure.
      // Message générique : le message PostgreSQL original ne doit jamais
      // être exposé dans la réponse. Le cause est disponible pour le logging
      // côté serveur via error.cause, mais n'est pas dans le responseBody.
      return new BookingDraftError(
        'UNKNOWN',
        'Le service de pricing est temporairement indisponible',
        {
          responseBody: {
            error: 'UNKNOWN',
            message: 'Le service de pricing est temporairement indisponible',
          },
        },
      );
    default: {
      // Exhaustive check — si un nouveau code est ajouté sans gestion, on échoue.
      const _exhaustive: never = error.code;
      return new BookingDraftError('VALIDATION', `Erreur pricing non gérée: ${_exhaustive}`, {
        responseBody: { error: 'VALIDATION', message: `Erreur pricing non gérée: ${_exhaustive}` },
      });
    }
  }
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
  // ── Discrimination du chemin (LEGACY vs FLEXIBLE) ──────────────────────
  // G7P-B2-B Round 2 — Defect 6 : dispatch fermé, aucun fallback silencieux.
  // La validation doit avoir lieu AVANT reserveKey — aucune mutation DB, aucun
  // enregistrement d'idempotence pour un mode invalide.
  if (input.pricingMode === 'FLEXIBLE') {
    return executeFlexiblePath(db, input);
  }
  if (input.pricingMode === 'LEGACY' || input.pricingMode === undefined) {
    return executeLegacyPath(db, input);
  }
  throw new BookingDraftError(
    'VALIDATION',
    `Mode de pricing invalide: ${String(input.pricingMode)}`,
  );
}

/**
 * Chemin legacy : logique existante inchangée.
 * Le seul changement est que le type d'entrée est maintenant `LegacyCreateBookingDraftInput`.
 */
async function executeLegacyPath(
  db: DatabaseClient,
  input: LegacyCreateBookingDraftInput,
): Promise<CreateBookingDraftResult> {
  // ── Étape A — Validation initiale (avant la base) ──────────────────────
  validateInput(input);

  // Agrégation canonique : fusionner les lignes ayant le même variantId.
  const aggregatedLines = aggregateLines(input.lines);

  // ── Étape A2 — Prévalidation de l'organisation (avant reserveKey) ──────
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
      const bookingDraftError = normalizeBusinessError(error);
      if (bookingDraftError === null) {
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

    await completeKey(tx, reservation.record.id, {
      resourceId: businessResult.resourceId,
      responseStatusCode: businessResult.statusCode,
      responseBody: businessResult.body,
    });
    return businessResult;
  });
}

/**
 * Chemin flexible : utilise le moteur de pricing flexible (G7P-B1).
 * Aucun fallback vers legacy : une erreur du moteur flexible est toujours
 * une erreur métier.
 */
async function executeFlexiblePath(
  db: DatabaseClient,
  input: FlexibleCreateBookingDraftInput,
): Promise<CreateBookingDraftResult> {
  // ── Étape A — Validation initiale (avant la base) ──────────────────────
  validateFlexibleInput(input);

  // Agrégation canonique : fusionner les lignes ayant le même variantId.
  const aggregatedLines = aggregateLines(input.lines);

  // ── Étape A2 — Prévalidation de l'organisation (avant reserveKey) ──────
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

  // ── Étape B — Calcul de l'empreinte flexible (v2) et reserveKey ────────
  const intentCanonical = buildIntentCanonicalForFingerprint(input.intent);
  const flexPayload: FlexibleIdempotentPayload = {
    organizationId: input.organizationId,
    locationId: input.locationId,
    customerUserId: input.customerUserId,
    locale: input.locale,
    intent: intentCanonical,
    lines: aggregatedLines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
    pricingMode: 'FLEXIBLE',
  };
  const fingerprint = computeFlexibleFingerprint(flexPayload);

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
  return await db.transaction(async (tx) => {
    const lock = await lockKey(tx, reservation.record.id);
    if (lock.kind === 'REPLAY') {
      return extractReplayResult(lock.record);
    }
    // LOCKED : exécuter la logique métier flexible dans un savepoint imbriqué.
    let businessResult: CreateBookingDraftSuccess;
    try {
      businessResult = await tx.transaction(async (sp) => {
        return await executeFlexibleBusinessLogic(sp, input, aggregatedLines);
      });
    } catch (error) {
      const bookingDraftError = normalizeBusinessError(error);
      if (bookingDraftError === null) {
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

    // ── SET CONSTRAINTS DEFERRED — restaurer le mode différé ─────────────
    // G7P-B2-B Round 2 — Defect 8 : SET CONSTRAINTS ciblé sur les contraintes
    // spécifiques plutôt que ALL. Le savepoint a pu passer SET CONSTRAINTS
    // IMMEDIATE ; on restaure le mode DEFERRED pour le reste de la transaction.
    await tx.execute(sql`SET CONSTRAINTS
      "booking_draft_lines_pricing_plan_id_fk",
      "after_validate_flexible_draft_aggregates_line",
      "after_validate_flexible_draft_aggregates_draft"
    DEFERRED`);

    await completeKey(tx, reservation.record.id, {
      resourceId: businessResult.resourceId,
      responseStatusCode: businessResult.statusCode,
      responseBody: businessResult.body,
    });
    return businessResult;
  });
}

/**
 * Construit la forme canonique de l'intent pour l'empreinte flexible.
 * TIME_RANGE → startAt/endAt en chaînes locales ISO 8601 sans offset.
 * DAY_RANGE → startDate/endDateExclusive en YYYY-MM-DD.
 */
function buildIntentCanonicalForFingerprint(
  intent: FlexibleBookingDraftIntent,
): FlexibleIntentCanonical {
  if (intent.kind === 'TIME_RANGE') {
    // G7P-B2-C Round 3 (P0-1) : l'empreinte est basée sur l'entrée locale du
    // client (chaînes locales), pas sur la conversion UTC. Deux entrées
    // locales identiques produisent la même empreinte quel que soit le fuseau
    // système.
    return {
      kind: 'TIME_RANGE',
      startAt: intent.startAt,
      endAt: intent.endAt,
    };
  }
  return {
    kind: 'DAY_RANGE',
    startDate: intent.startDate,
    endDateExclusive: intent.endDateExclusive,
  };
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
 * Valide l'entrée legacy avant toute interaction avec la base.
 * @throws BookingDraftError('VALIDATION') si une contrainte n'est pas respectée.
 */
function validateInput(input: LegacyCreateBookingDraftInput): void {
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
 * Valide l'entrée flexible avant toute interaction avec la base.
 * @throws BookingDraftError('VALIDATION') si une contrainte n'est pas respectée.
 */
function validateFlexibleInput(input: FlexibleCreateBookingDraftInput): void {
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
  if (!input.locale || input.locale.trim().length === 0) {
    throw new BookingDraftError('VALIDATION', 'locale est requis.');
  }
  if (!input.intent) {
    throw new BookingDraftError('VALIDATION', 'intent est requis.');
  }
  if (input.intent.kind === 'TIME_RANGE') {
    // G7P-B2-B Round 3 : validation civile et syntaxique AVANT tout accès DB.
    // On délègue la validation sémantique complète (mois 1-12, jour valide pour
    // le mois/année incluant les années bissextiles, heure 0-23, minute 0-59,
    // seconde 0-59, refus des offsets 'Z' et '+HH:MM') au parseur central
    // parseLocalDateTimeString. Aucune seconde regex permissive n'est maintenue
    // séparément — le parseur est l'unique source de vérité.
    //
    // Distinction importante :
    // - Validation civile et syntaxique (format, plages, jour réel) : ici, AVANT
    //   reserveKey, avant toute lecture/écriture PostgreSQL, avant toute
    //   création de draft/hold/allocation.
    // - Résolution par fuseau du lieu (NON_EXISTENT_LOCAL_TIME, AMBIGUOUS_LOCAL_TIME,
    //   INVALID_TIMEZONE du lieu) : reste dans le chemin transactionnel sécurisé
    //   (executeFlexibleBusinessLogic), APRÈS le chargement du lieu, car elle
    //   dépend du fuseau IANA du lieu qui n'est connu qu'après une lecture DB.
    if (typeof input.intent.startAt !== 'string') {
      throw new BookingDraftError(
        'VALIDATION',
        'intent.startAt doit être une chaîne ISO 8601 locale sans offset (ex : "2026-08-08T22:08:00").',
      );
    }
    if (typeof input.intent.endAt !== 'string') {
      throw new BookingDraftError(
        'VALIDATION',
        'intent.endAt doit être une chaîne ISO 8601 locale sans offset (ex : "2026-08-08T22:08:00").',
      );
    }
    try {
      parseLocalDateTimeString(input.intent.startAt);
      parseLocalDateTimeString(input.intent.endAt);
    } catch (err) {
      if (err instanceof LocalToUtcError) {
        throw new BookingDraftError('VALIDATION', err.message, {
          responseBody: {
            error: 'VALIDATION',
            message: err.message,
            details: { localToUtcErrorCode: err.code },
          },
        });
      }
      throw err;
    }
    // Comparaison canonique uniquement après validation sémantique.
    if (!(input.intent.endAt > input.intent.startAt)) {
      throw new BookingDraftError(
        'VALIDATION',
        'La période TIME_RANGE doit être strictement positive (endAt > startAt).',
      );
    }
  } else if (input.intent.kind === 'DAY_RANGE') {
    if (!input.intent.startDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.intent.startDate)) {
      throw new BookingDraftError('VALIDATION', 'intent.startDate doit être au format YYYY-MM-DD.');
    }
    if (
      !input.intent.endDateExclusive ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.intent.endDateExclusive)
    ) {
      throw new BookingDraftError(
        'VALIDATION',
        'intent.endDateExclusive doit être au format YYYY-MM-DD.',
      );
    }
    if (!(input.intent.endDateExclusive > input.intent.startDate)) {
      throw new BookingDraftError(
        'VALIDATION',
        'La période DAY_RANGE doit être strictement positive (endDateExclusive > startDate).',
      );
    }
  } else {
    throw new BookingDraftError('VALIDATION', 'intent.kind invalide.');
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
  input: LegacyCreateBookingDraftInput,
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

// ─────────────────────────────────────────────────────────────────────────────
// G7P-B2-B — Logique métier flexible
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Logique métier flexible, exécutée dans la transaction après le savepoint.
 *
 * Étapes :
 * 1. Charger et valider l'organisation, le lieu, l'utilisateur.
 * 2. Appeler quoteFlexiblePricing pour calculer le devis.
 * 3. Dériver customer_start_at/customer_end_at depuis l'intent.
 * 4. Dériver blocked_start_at/blocked_end_at avec les buffers.
 * 5. Valider le catalogue (PUBLISHED, active variant, same org) — sans exiger daily_price_amount_minor.
 * 6. Sélectionner et verrouiller les exemplaires (FOR UPDATE SKIP LOCKED).
 * 7. Insérer booking_drafts avec toutes les colonnes flexibles.
 * 8. Insérer booking_draft_lines avec toutes les colonnes flexibles.
 * 9. Insérer inventory_blocks (HOLD) et allocations.
 * 10. SET CONSTRAINTS ALL IMMEDIATE — forcer l'évaluation des triggers différés.
 * 11. Construire la réponse flexible.
 *
 * @throws BookingDraftError pour les erreurs métier attendues.
 * @throws Error pour les erreurs techniques (rollback complet).
 */
async function executeFlexibleBusinessLogic(
  tx: DatabaseTransaction,
  input: FlexibleCreateBookingDraftInput,
  aggregatedLines: AggregatedLine[],
): Promise<CreateBookingDraftSuccess> {
  // 1. Charger et valider l'organisation.
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

  // 4. Appeler le moteur de pricing flexible.
  const quoteResult = await quoteFlexiblePricing(tx as unknown as DatabaseClient, {
    organizationId: input.organizationId,
    locationId: input.locationId,
    locale: input.locale,
    intent: input.intent,
    lines: aggregatedLines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
  });

  // 5. Dériver customer_start_at / customer_end_at depuis l'intent et le devis.
  let customerStartAt: Date;
  let customerEndAt: Date;

  if (input.intent.kind === 'TIME_RANGE') {
    // G7P-B2-C Round 3 (P0-1) : Convertir les chaînes de date+heure locale
    // (sans offset) en UTC using le fuseau IANA du lieu. L'entrée du client
    // représente l'heure locale du lieu de location (ex : "22h08" = 22h08
    // Europe/Paris), pas 22h08 UTC.
    customerStartAt = localDateTimeStringToUtc(input.intent.startAt, timeZone);
    customerEndAt = localDateTimeStringToUtc(input.intent.endAt, timeZone);
  } else {
    // DAY_RANGE : pour chaque ligne DAILY, utiliser dayRangeBoundaries pour
    // convertir firstDay.startTime et lastDay.endTime en UTC.
    let minStartUtc: Date | null = null;
    let maxEndUtc: Date | null = null;

    for (const quoteLine of quoteResult.lines) {
      if (quoteLine.planType === 'DAILY' && quoteLine.dayRangeBoundaries) {
        const firstDay = quoteLine.dayRangeBoundaries.firstDay;
        const lastDay = quoteLine.dayRangeBoundaries.lastDay;

        const firstStartUtc = localDateTimeToUtc(
          parseLocalDateTime(firstDay.localDate, firstDay.startTime),
          timeZone,
        );
        const lastEndUtc = localDateTimeToUtc(
          parseLocalDateTime(lastDay.localDate, lastDay.endTime),
          timeZone,
        );

        if (minStartUtc === null || firstStartUtc.getTime() < minStartUtc.getTime()) {
          minStartUtc = firstStartUtc;
        }
        if (maxEndUtc === null || lastEndUtc.getTime() > maxEndUtc.getTime()) {
          maxEndUtc = lastEndUtc;
        }
      }
    }

    if (minStartUtc === null || maxEndUtc === null) {
      throw new BookingDraftError(
        'VALIDATION',
        'DAY_RANGE : impossible de dériver customer_start_at/customer_end_at — aucune ligne DAILY avec dayRangeBoundaries.',
      );
    }
    customerStartAt = minStartUtc;
    customerEndAt = maxEndUtc;
  }

  // 6. Dériver la période bloquée.
  const blockedStartAt = new Date(customerStartAt.getTime() - prepBufferMinutes * 60 * 1000);
  const blockedEndAt = new Date(customerEndAt.getTime() + cleanupBufferMinutes * 60 * 1000);

  // 7. Valider le catalogue (pour chaque variante agrégée).
  // Pas d'exigence sur daily_price_amount_minor en mode flexible.
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

  // 8. Sélectionner et verrouiller les exemplaires (FOR UPDATE SKIP LOCKED).
  const sortedQuoteLines = [...quoteResult.lines].sort((a, b) =>
    a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0,
  );
  const selectedItemsByVariant = new Map<
    string,
    Array<{ id: string; internalSku: string; productVariantId: string }>
  >();

  for (const quoteLine of sortedQuoteLines) {
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
          eq(inventoryItems.productVariantId, quoteLine.variantId),
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
      .limit(quoteLine.quantity);

    if (eligibleItems.length < quoteLine.quantity) {
      const message = `Stock insuffisant pour la variante ${quoteLine.variantId}: demandé ${quoteLine.quantity}, disponible ${eligibleItems.length}.`;
      throw new BookingDraftError('CONFLICT_BLOCK', message, {
        statusCode: 409,
        responseBody: {
          error: 'CONFLICT_BLOCK',
          message,
          details: {
            reason: 'INSUFFICIENT_STOCK',
            variantId: quoteLine.variantId,
            requested: quoteLine.quantity,
            available: eligibleItems.length,
          },
        },
      });
    }
    selectedItemsByVariant.set(quoteLine.variantId, eligibleItems);
  }

  // 9. Calculer l'échéance avec l'horloge PostgreSQL.
  const expiresAtResult = await tx.execute(
    sql`SELECT (transaction_timestamp() + interval '${sql.raw(String(HOLD_DURATION_MINUTES))} minutes') AS expires_at`,
  );
  const rawExpiresAt = (expiresAtResult[0] as unknown as { expires_at: Date | string }).expires_at;
  const draftExpiresAt = rawExpiresAt instanceof Date ? rawExpiresAt : new Date(rawExpiresAt);

  // 10. Dériver billable_unit et billable_unit_count.
  // G7P-B2-B Round 2 — Defect 4 : billableUnitCount provient du moteur (quoteLine.billableUnitCount).
  // Le billableUnitCount au niveau du draft est la somme des billableUnitCount * quantity de chaque ligne.
  const billableUnit = input.intent.kind === 'TIME_RANGE' ? 'MINUTE' : 'DAY';
  const billableUnitCount = sortedQuoteLines.reduce(
    (sum, line) => sum + line.billableUnitCount * line.quantity,
    0,
  );

  // 11. Construire l'intent snapshot canonique pour la persistance.
  const intentSnapshot = buildIntentSnapshot(input.intent);

  // 12. Insérer le brouillon en statut DRAFT (le trigger enforce_draft_line_immutability
  // exige que le parent soit DRAFT pour l'insertion de lignes sur les drafts flexibles).
  const insertedDraft = await tx
    .insert(bookingDrafts)
    .values({
      organizationId: input.organizationId,
      locationId: input.locationId,
      customerUserId: input.customerUserId,
      status: 'DRAFT',
      customerStartAt,
      customerEndAt,
      blockedStartAt,
      blockedEndAt,
      timezone: timeZone,
      prepBufferMinutes,
      cleanupBufferMinutes,
      currency: 'EUR',
      subtotalAmountMinor: quoteResult.subtotalAmountMinor,
      mandatoryFeesAmountMinor: 0,
      totalAmountMinor: quoteResult.totalAmountMinor,
      // G7P-B2-C Round 3 (P0-2) — financial terms are UNDETERMINED at draft stage
      // per ADR-010 §6. They are resolved at payment initiation by
      // resolveFinancialTerms and persisted on `payments`. The confirmed booking
      // copies tax/commission from `payments` (not from the draft). The
      // validate_flexible_booking_aggregates trigger enforces exact copy for
      // rental pricing fields only, NOT for tax/commission/terms.
      taxStatus: 'UNDETERMINED',
      taxAmountMinor: null,
      taxRateBps: null,
      commissionAmountMinor: null,
      billableUnit,
      billableUnitCount,
      cancellationPolicySnapshot: {
        policy_code: policyCode,
        policy_version: CANCELLATION_POLICY_SNAPSHOT_VERSION,
        timezone: timeZone,
      },
      expiresAt: draftExpiresAt,
      pricingSnapshotVersion: 'flexible-pricing-v1',
      pricingAlgorithmVersion: quoteResult.algorithmVersion,
      pricingRoundingRuleVersion: quoteResult.roundingRuleVersion,
      pricingIntentType: input.intent.kind,
      pricingIntentSnapshot: intentSnapshot,
      pricingResolvedLocale: quoteResult.resolvedLocale,
    })
    .returning();
  const draftId = insertedDraft[0]!.id;

  // 13. Insérer les lignes avec toutes les colonnes flexibles.
  const lineIdMap = new Map<string, string>();
  for (const quoteLine of sortedQuoteLines) {
    const vd = variantDataMap.get(quoteLine.variantId)!;
    const insertedLine = await tx
      .insert(bookingDraftLines)
      .values({
        draftId,
        variantId: quoteLine.variantId,
        quantity: quoteLine.quantity,
        unitPriceAmountMinor: quoteLine.unitPriceAmountMinor,
        billableUnitCount: quoteLine.billableUnitCount,
        lineTotalAmountMinor: quoteLine.lineTotalAmountMinor,
        currency: 'EUR',
        variantSnapshot: vd.snapshot,
        pricingPlanId: quoteLine.pricingPlanId,
        pricingPlanVersion: quoteLine.planVersion,
        pricingPlanType: quoteLine.planType,
        pricingPublicLabel: quoteLine.publicLabel,
        // DAY_RANGE requires NULL pricing_requested_duration_minutes (trigger enforce_draft_line_pricing_coherence).
        // TIME_RANGE requires > 0.
        pricingRequestedDurationMinutes:
          input.intent.kind === 'DAY_RANGE' ? null : quoteLine.requestedDurationMinutes,
        pricingBilledDurationMinutes: quoteLine.billedDurationMinutes,
        pricingCoveredDurationMinutes: quoteLine.coveredDurationMinutes,
        pricingBilledDays: quoteLine.billedDays,
        pricingSelectedWindow: quoteLine.windowSnapshot,
        pricingDiscountThresholdDays: quoteLine.discountThresholdDays,
        pricingDiscountPercent: quoteLine.discountPercent,
        pricingAmountBeforeDiscountMinor: quoteLine.amountBeforeDiscountMinor,
        pricingAmountAfterDiscountMinor: quoteLine.amountAfterDiscountMinor,
      })
      .returning();
    lineIdMap.set(quoteLine.variantId, insertedLine[0]!.id);
  }

  // 14. Transition DRAFT → HELD avant les allocations (le trigger d'allocation
  // exige que le brouillon soit HELD, mais le trigger de ligne exige DRAFT).
  await tx.update(bookingDrafts).set({ status: 'HELD' }).where(eq(bookingDrafts.id, draftId));

  // 15. Créer les HOLDs et allocations.
  const allAllocations: Array<BookingDraftAllocation & { variantId: string }> = [];
  for (const quoteLine of sortedQuoteLines) {
    const lineId = lineIdMap.get(quoteLine.variantId)!;
    for (const item of selectedItemsByVariant.get(quoteLine.variantId)!) {
      const insertedBlock = await tx
        .insert(inventoryBlocks)
        .values({
          organizationId: input.organizationId,
          inventoryItemId: item.id,
          type: 'HOLD',
          status: 'ACTIVE',
          customerStartAt,
          customerEndAt,
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
        variantId: quoteLine.variantId,
        allocationId: insertedAllocation[0]!.id,
        inventoryBlockId: blockId,
        inventoryItemId: item.id,
        internalSku: item.internalSku,
      });
    }
  }

  // 16. SET CONSTRAINTS IMMEDIATE — forcer l'évaluation des triggers différés.
  // G7P-B2-B Round 2 — Defect 8 : SET CONSTRAINTS ciblé sur les contraintes
  // spécifiques plutôt que ALL, pour éviter d'affecter d'autres contraintes
  // différées potentielles.
  // Si un invariant échoue (ex. validate_flexible_draft_aggregates), l'erreur
  // est levée ici, dans le savepoint, qui sera annulé. Aucun SUCCESS ne sera
  // persisté.
  await tx.execute(sql`SET CONSTRAINTS
    "booking_draft_lines_pricing_plan_id_fk",
    "after_validate_flexible_draft_aggregates_line",
    "after_validate_flexible_draft_aggregates_draft"
  IMMEDIATE`);

  // 16. Construire la réponse flexible.
  const response: FlexibleBookingDraftResponseBody = {
    draftId,
    status: 'HELD',
    organizationId: input.organizationId,
    locationId: input.locationId,
    customerUserId: input.customerUserId,
    customerStartAt: customerStartAt.toISOString(),
    customerEndAt: customerEndAt.toISOString(),
    blockedStartAt: blockedStartAt.toISOString(),
    blockedEndAt: blockedEndAt.toISOString(),
    expiresAt: draftExpiresAt.toISOString(),
    currency: 'EUR',
    billableUnit: billableUnit as 'DAY' | 'MINUTE',
    billableUnitCount,
    subtotalAmountMinor: quoteResult.subtotalAmountMinor,
    mandatoryFeesAmountMinor: 0,
    totalAmountMinor: quoteResult.totalAmountMinor,
    // G7P-B2-C Round 3 (P0-2) — financial terms are UNDETERMINED at draft stage
    // per ADR-010 §6. Resolved at payment initiation, copied from `payments`
    // during confirmation.
    taxStatus: 'UNDETERMINED',
    taxAmountMinor: null,
    taxRateBps: null,
    commissionAmountMinor: null,
    cancellationPolicySnapshot: {
      policy_code: policyCode,
      policy_version: CANCELLATION_POLICY_SNAPSHOT_VERSION,
      timezone: timeZone,
    },
    pricingSnapshotVersion: 'flexible-pricing-v1',
    pricingAlgorithmVersion: quoteResult.algorithmVersion,
    pricingRoundingRuleVersion: quoteResult.roundingRuleVersion,
    pricingIntentType: input.intent.kind,
    pricingIntentSnapshot: intentSnapshot,
    pricingResolvedLocale: quoteResult.resolvedLocale,
    timezone: timeZone,
    lines: sortedQuoteLines.map((quoteLine): FlexibleBookingDraftResponseLine => {
      const vd = variantDataMap.get(quoteLine.variantId)!;
      return {
        lineId: lineIdMap.get(quoteLine.variantId)!,
        variantId: quoteLine.variantId,
        quantity: quoteLine.quantity,
        unitPriceAmountMinor: quoteLine.unitPriceAmountMinor,
        billableUnitCount: quoteLine.billableUnitCount,
        lineTotalAmountMinor: quoteLine.lineTotalAmountMinor,
        currency: 'EUR',
        variantSnapshot: vd.snapshot,
        allocations: allAllocations
          .filter((allocation) => allocation.variantId === quoteLine.variantId)
          .map(({ variantId: _variantId, ...allocation }) => allocation),
        pricingPlanId: quoteLine.pricingPlanId,
        pricingPlanVersion: quoteLine.planVersion,
        pricingPlanType: quoteLine.planType,
        pricingPublicLabel: quoteLine.publicLabel,
        pricingRequestedDurationMinutes:
          input.intent.kind === 'DAY_RANGE' ? null : quoteLine.requestedDurationMinutes,
        pricingBilledDurationMinutes: quoteLine.billedDurationMinutes,
        pricingCoveredDurationMinutes: quoteLine.coveredDurationMinutes,
        pricingBilledDays: quoteLine.billedDays,
        pricingSelectedWindow: quoteLine.windowSnapshot,
        pricingDiscountThresholdDays: quoteLine.discountThresholdDays,
        pricingDiscountPercent: quoteLine.discountPercent,
        pricingAmountBeforeDiscountMinor: quoteLine.amountBeforeDiscountMinor,
        pricingAmountAfterDiscountMinor: quoteLine.amountAfterDiscountMinor,
      };
    }),
  };

  return { kind: 'SUCCESS', statusCode: 201, body: response, resourceId: draftId };
}

/**
 * Construit l'intent snapshot canonique pour la persistance dans pricing_intent_snapshot.
 * TIME_RANGE : { kind, startAt (local string), endAt (local string) }.
 * DAY_RANGE : { kind, startDate, endDateExclusive }.
 *
 * G7P-B2-C Round 3 (P0-1) : Pour TIME_RANGE, le snapshot stocke les chaînes
 * locales telles quelles (pas la conversion UTC) afin d'être lisible et
 * indépendant du fuseau. La conversion UTC est stockée séparément dans
 * `customer_start_at` / `customer_end_at`.
 */
function buildIntentSnapshot(intent: FlexibleBookingDraftIntent): Record<string, unknown> {
  if (intent.kind === 'TIME_RANGE') {
    return {
      kind: 'TIME_RANGE',
      startAt: intent.startAt,
      endAt: intent.endAt,
    };
  }
  return {
    kind: 'DAY_RANGE',
    startDate: intent.startDate,
    endDateExclusive: intent.endDateExclusive,
  };
}

/**
 * Parse une date locale (YYYY-MM-DD) et une heure (HH:MM:SS) en LocalDateTime.
 */
function parseLocalDateTime(dateStr: string, timeStr: string): LocalDateTime {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!dateMatch) {
    throw new BookingDraftError('VALIDATION', `Format de date invalide: ${dateStr}`);
  }
  const timeMatch = /^(\d{2}):(\d{2}):(\d{2})$/.exec(timeStr);
  if (!timeMatch) {
    throw new BookingDraftError('VALIDATION', `Format d'heure invalide: ${timeStr}`);
  }
  return {
    year: parseInt(dateMatch[1]!, 10),
    month: parseInt(dateMatch[2]!, 10),
    day: parseInt(dateMatch[3]!, 10),
    hour: parseInt(timeMatch[1]!, 10),
    minute: parseInt(timeMatch[2]!, 10),
    second: parseInt(timeMatch[3]!, 10),
  };
}
