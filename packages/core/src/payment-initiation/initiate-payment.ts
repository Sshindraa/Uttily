import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  allocations,
  bookingDraftLines,
  bookingDrafts,
  type DatabaseTransaction,
  inventoryBlocks,
  lockOrganization,
  organizationPaymentAccounts,
  paymentAttempts,
  payments,
} from '@uttily/database';
import { FinancialTermsError } from '../financial-terms/errors';
import { resolveFinancialTerms } from '../financial-terms/resolve-financial-terms';
import { completeKey, failKey, lockKey, reserveKey } from '../idempotency';
import type { IdempotencyRecordRow } from '../idempotency';
import { PaymentProviderError } from '../payments/errors';
import type {
  CreatePaymentIntentParams,
  PaymentIntentResult,
  PaymentIntentStatus,
} from '../payments/types';
import { PaymentInitiationError } from './errors';
import { computePaymentFingerprint } from './fingerprint';
import type {
  InitiatePaymentDependencies,
  InitiatePaymentInput,
  InitiatePaymentResult,
  InitiatePaymentFailure,
  PersistedPaymentResponse,
} from './types';
import { INITIATE_PAYMENT_OPERATION, PAYMENT_PROTOCOL_VERSION } from './types';

/**
 * @uttily/core — Initiation de paiement (Lot 5, ADR-010 §7).
 *
 * Use case d'initiation de paiement : convertit un brouillon HELD en
 * PAYMENT_PROCESSING, crée un payment + payment_attempt, appelle le provider
 * Stripe HORS transaction, puis projette la réponse du provider.
 *
 * Contraintes critiques (ADR-010 §1, §7, §8) :
 * - Aucun appel Stripe à l'intérieur d'une transaction PostgreSQL ou sous un
 *   verrou FOR UPDATE.
 * - PostgreSQL est l'autorité locale ; le webhook Stripe est l'autorité externe
 *   de confirmation. La réponse du provider n'est PAS une autorité de
 *   confirmation : seul un webhook signé futur peut créer la réservation.
 * - organizationId et customerUserId proviennent du contexte serveur, jamais
 *   du navigateur.
 * - Aucun montant, compte connecté ou commission accepté depuis le navigateur.
 * - Le PaymentIntent est construit UNIQUEMENT depuis le snapshot persistant.
 * - Le client_secret n'est JAMAIS persisté, loggé, inclus dans
 *   idempotency_records ou placé dans une URL.
 * - Same local key + same request = same logical payment and same PaymentIntent.
 * - Same local key + different request = 409 CONFLICT_IDEMPOTENCY.
 * - Deux clés différentes ciblant le même draft ne créent PAS deux paiements ni
 *   deux PaymentIntents.
 * - Toutes les unités transitent ensemble vers PAYMENT_PROCESSING, ou aucune.
 * - Un brouillon expiré au moment du verrou ne peut jamais être converti.
 * - Les allocations restent ALLOCATED pendant PAYMENT_PROCESSING.
 * - Jamais activer Stripe LIVE.
 */

/** Durée du délai de traitement avant expiration (30 minutes). */
const PROCESSING_DEADLINE_INTERVAL = sql.raw("interval '30 minutes'");

/**
 * Mappe un statut PaymentIntent du provider vers le statut local
 * payment_attempt_status (monotone).
 *
 * Le statut local est une projection monotone : SUCCEEDED ne régresse jamais.
 * Le statut du provider n'est PAS une autorité de confirmation : seul un
 * webhook signé futur peut créer la réservation.
 */
export function mapProviderStatusToLocal(
  providerStatus: PaymentIntentStatus,
):
  | 'PENDING_PROVIDER'
  | 'REQUIRES_PAYMENT_METHOD'
  | 'REQUIRES_ACTION'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED' {
  switch (providerStatus) {
    case 'requires_payment_method':
      return 'REQUIRES_PAYMENT_METHOD';
    case 'requires_action':
      return 'REQUIRES_ACTION';
    case 'processing':
      return 'PROCESSING';
    case 'succeeded':
      return 'SUCCEEDED';
    case 'canceled':
      return 'CANCELLED';
    default:
      // Ne devrait jamais arriver : l'union est fermée.
      return 'FAILED';
  }
}

/** Valide le format canonique d'un UUID (8-4-4-4-12 hex). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateUuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) {
    throw new PaymentInitiationError('VALIDATION', `${field} doit être un UUID valide.`);
  }
}

/**
 * Valide l'entrée avant toute interaction avec la base.
 * @throws PaymentInitiationError('VALIDATION') si une contrainte n'est pas respectée.
 */
function validateInput(input: InitiatePaymentInput): void {
  if (!input.organizationId || input.organizationId.length === 0) {
    throw new PaymentInitiationError('VALIDATION', 'organizationId est requis.');
  }
  validateUuid(input.organizationId, 'organizationId');

  if (!input.customerUserId || input.customerUserId.length === 0) {
    throw new PaymentInitiationError('VALIDATION', 'customerUserId est requis.');
  }
  validateUuid(input.customerUserId, 'customerUserId');

  if (!input.draftId || input.draftId.length === 0) {
    throw new PaymentInitiationError('VALIDATION', 'draftId est requis.');
  }
  validateUuid(input.draftId, 'draftId');

  if (!input.idempotencyKey || input.idempotencyKey.length === 0) {
    throw new PaymentInitiationError('VALIDATION', 'idempotencyKey est requis.');
  }

  if (input.environment !== 'TEST' && input.environment !== 'LIVE') {
    throw new PaymentInitiationError(
      'VALIDATION',
      `environment doit être 'TEST' ou 'LIVE' (reçu : ${input.environment}).`,
    );
  }

  if (!input.termsAcceptance || !input.termsAcceptance.termsVersion) {
    throw new PaymentInitiationError('VALIDATION', 'termsAcceptance.termsVersion est requis.');
  }

  if (input.termsAcceptance.userId !== input.customerUserId) {
    throw new PaymentInitiationError(
      'CUSTOMER_MISMATCH',
      "L'utilisateur qui a accepté les termes ne correspond pas au client authentifié.",
      { statusCode: 403 },
    );
  }
}

/**
 * Traduit une erreur métier attendue en PaymentInitiationError.
 * Retourne null si l'erreur n'est pas une erreur métier reconnue (erreur
 * technique inattendue).
 */
function normalizeBusinessError(error: unknown): PaymentInitiationError | null {
  if (error instanceof PaymentInitiationError) return error;
  if (error instanceof FinancialTermsError) {
    if (error.code === 'FINANCIAL_TERMS_UNRESOLVED') {
      return new PaymentInitiationError('FINANCIAL_TERMS_UNRESOLVED', error.message, {
        statusCode: 400,
      });
    }
    if (error.code === 'PAYMENT_ACCOUNT_NOT_READY') {
      return new PaymentInitiationError('CONNECTED_ACCOUNT_NOT_READY', error.message, {
        statusCode: 400,
      });
    }
    // VALIDATION ou autres codes financiers.
    return new PaymentInitiationError('VALIDATION', error.message, { statusCode: 400 });
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transaction A — Prise de contrôle locale (local takeover)
// ─────────────────────────────────────────────────────────────────────────────

/** Données retournées par Transaction A pour l'appel provider (après commit). */
interface TransactionAResult {
  kind: 'LOCKED';
  paymentId: string;
  paymentAttemptId: string;
  providerIdempotencyKey: string;
  providerPaymentIntentId: string | null;
  amountMinor: number;
  connectedAccountId: string;
  commissionAmountMinor: number;
  onBehalfOfAccountId: string | null;
  processingDeadlineAt: Date;
}

/** Résultat interne de Transaction A (LOCKED ou REPLAY). */
type TransactionAOutcome = TransactionAResult | { kind: 'REPLAY'; record: IdempotencyRecordRow };

/**
 * Exécute la logique métier de prise de contrôle locale dans un savepoint.
 *
 * @throws PaymentInitiationError pour les erreurs métier attendues.
 * @throws Error pour les erreurs techniques (rollback complet).
 */
async function executeTakeover(
  tx: DatabaseTransaction,
  input: InitiatePaymentInput,
): Promise<TransactionAResult> {
  // 1. Verrou advisory sur l'organisation.
  await lockOrganization(tx, input.organizationId);

  // 2. Verrouiller le brouillon FOR UPDATE.
  const draftRows = await tx
    .select()
    .from(bookingDrafts)
    .where(eq(bookingDrafts.id, input.draftId))
    .for('update')
    .limit(1);

  if (draftRows.length === 0) {
    throw new PaymentInitiationError('DRAFT_NOT_FOUND', 'Brouillon introuvable.', {
      statusCode: 404,
    });
  }
  const draft = draftRows[0]!;

  // 3. Vérifier l'organisation et le customer_user_id.
  if (draft.organizationId !== input.organizationId) {
    throw new PaymentInitiationError(
      'ORGANIZATION_MISMATCH',
      "L'organisation du brouillon ne correspond pas à l'organisation du contexte.",
      { statusCode: 403 },
    );
  }
  if (draft.customerUserId !== input.customerUserId) {
    throw new PaymentInitiationError(
      'CUSTOMER_MISMATCH',
      "L'utilisateur client du brouillon ne correspond pas au contexte.",
      { statusCode: 403 },
    );
  }

  // 4. Vérifier le statut du brouillon.
  if (draft.status === 'EXPIRED') {
    throw new PaymentInitiationError('DRAFT_EXPIRED', 'Le brouillon est expiré.', {
      statusCode: 400,
    });
  }
  if (draft.status === 'CANCELLED' || draft.status === 'DRAFT' || draft.status === 'CONVERTED') {
    throw new PaymentInitiationError(
      'DRAFT_NOT_HELD',
      `Le brouillon n'est pas en statut HELD (reçu : ${draft.status}).`,
      { statusCode: 400 },
    );
  }

  // 5. Si HELD : vérifier transaction_timestamp() < expires_at.
  if (draft.status === 'HELD') {
    const expiryCheck = await tx
      .select({ isExpired: sql<boolean>`transaction_timestamp() >= ${bookingDrafts.expiresAt}` })
      .from(bookingDrafts)
      .where(eq(bookingDrafts.id, input.draftId))
      .limit(1);
    if (expiryCheck.length > 0 && expiryCheck[0]!.isExpired) {
      throw new PaymentInitiationError(
        'DRAFT_EXPIRED',
        'Le brouillon a expiré au moment du verrou.',
        {
          statusCode: 400,
        },
      );
    }
  }

  // 6. Si PAYMENT_PROCESSING : retry — vérifier la cohérence.
  // (Le draft est déjà en PAYMENT_PROCESSING, on ne re-transitionne pas.)
  // La cohérence est vérifiée plus loin via le payment existant.

  // 7. Verrouiller les inventory_blocks FOR UPDATE (tous les blocs pour ce draft, ordonnés par id).
  const blocks = await tx
    .select()
    .from(inventoryBlocks)
    .where(eq(inventoryBlocks.sourceId, input.draftId))
    .orderBy(inventoryBlocks.id)
    .for('update');

  if (blocks.length === 0) {
    throw new PaymentInitiationError(
      'HOLD_INCONSISTENT',
      'Aucun bloc de hold trouvé pour ce brouillon.',
      { statusCode: 400 },
    );
  }

  // Vérifier que tous les blocs sont dans le statut attendu.
  if (draft.status === 'HELD') {
    for (const block of blocks) {
      if (block.status !== 'ACTIVE') {
        throw new PaymentInitiationError(
          'HOLD_INCONSISTENT',
          `Bloc ${block.id} n'est pas ACTIVE (reçu : ${block.status}).`,
          { statusCode: 400 },
        );
      }
    }
  } else if (draft.status === 'PAYMENT_PROCESSING') {
    for (const block of blocks) {
      if (block.status !== 'PAYMENT_PROCESSING') {
        throw new PaymentInitiationError(
          'HOLD_INCONSISTENT',
          `Bloc ${block.id} n'est pas PAYMENT_PROCESSING (reçu : ${block.status}).`,
          { statusCode: 400 },
        );
      }
    }
  }

  // 8. Verrouiller les allocations FOR UPDATE (toutes les allocations pour ces blocs, ordonnées par id).
  const blockIds = blocks.map((b) => b.id);
  const allocs = await tx
    .select()
    .from(allocations)
    .where(inArray(allocations.inventoryBlockId, blockIds))
    .orderBy(allocations.id)
    .for('update');

  // Vérifier que toutes les allocations sont ALLOCATED.
  for (const alloc of allocs) {
    if (alloc.status !== 'ALLOCATED') {
      throw new PaymentInitiationError(
        'ALLOCATION_INCONSISTENT',
        `Allocation ${alloc.id} n'est pas ALLOCATED (reçu : ${alloc.status}).`,
        { statusCode: 400 },
      );
    }
  }

  // 9. Charger les booking_draft_lines et vérifier la devise EUR.
  const lines = await tx
    .select()
    .from(bookingDraftLines)
    .where(eq(bookingDraftLines.draftId, input.draftId));

  if (lines.length === 0) {
    throw new PaymentInitiationError('HOLD_INCONSISTENT', 'Aucune ligne de brouillon trouvée.', {
      statusCode: 400,
    });
  }
  for (const line of lines) {
    if (line.currency !== 'EUR') {
      throw new PaymentInitiationError(
        'CURRENCY_NOT_EUR',
        `La ligne ${line.id} n'est pas en EUR (reçu : ${line.currency}).`,
        { statusCode: 400 },
      );
    }
  }
  if (draft.currency !== 'EUR') {
    throw new PaymentInitiationError(
      'CURRENCY_NOT_EUR',
      `Le brouillon n'est pas en EUR (reçu : ${draft.currency}).`,
      { statusCode: 400 },
    );
  }

  // 9b. Invariants complets draft/holds/allocations.

  // a. Tous les blocs doivent être de type HOLD et non supprimés.
  for (const block of blocks) {
    if (block.type !== 'HOLD') {
      throw new PaymentInitiationError(
        'HOLD_INCONSISTENT',
        `Le bloc ${block.id} n'est pas de type HOLD (reçu : ${block.type}).`,
        { statusCode: 400 },
      );
    }
    if (block.deletedAt !== null) {
      throw new PaymentInitiationError(
        'HOLD_INCONSISTENT',
        `Le bloc ${block.id} est supprimé (soft delete).`,
        { statusCode: 400 },
      );
    }
  }

  // b. SUM(lines.quantity) == blocks.length == allocations.length
  const totalQuantity = lines.reduce((sum, l) => sum + l.quantity, 0);
  if (totalQuantity !== blocks.length) {
    throw new PaymentInitiationError(
      'HOLD_INCONSISTENT',
      `La quantité totale des lignes (${totalQuantity}) ne correspond pas au nombre de blocs (${blocks.length}).`,
      { statusCode: 400 },
    );
  }
  if (blocks.length !== allocs.length) {
    throw new PaymentInitiationError(
      'ALLOCATION_INCONSISTENT',
      `Le nombre de blocs (${blocks.length}) ne correspond pas au nombre d'allocations (${allocs.length}).`,
      { statusCode: 400 },
    );
  }

  // c. Exactement une allocation par bloc.
  const blockIdsWithAlloc = new Set(allocs.map((a) => a.inventoryBlockId));
  for (const block of blocks) {
    if (!blockIdsWithAlloc.has(block.id)) {
      throw new PaymentInitiationError(
        'ALLOCATION_INCONSISTENT',
        `Le bloc ${block.id} n'a pas d'allocation associée.`,
        { statusCode: 400 },
      );
    }
  }
  // Vérifier qu'il n'y a pas d'allocations en double par bloc (exactement 1).
  const allocCounts = new Map<string, number>();
  for (const alloc of allocs) {
    allocCounts.set(alloc.inventoryBlockId, (allocCounts.get(alloc.inventoryBlockId) ?? 0) + 1);
  }
  for (const [blockId, count] of allocCounts) {
    if (count !== 1) {
      throw new PaymentInitiationError(
        'ALLOCATION_INCONSISTENT',
        `Le bloc ${blockId} a ${count} allocations (attendu : exactement 1).`,
        { statusCode: 400 },
      );
    }
  }

  // d. Échéances communes : tous les blocs ont la même échéance (expires_at).
  if (draft.status === 'HELD') {
    const expiryTimes = new Set(blocks.map((b) => b.expiresAt?.getTime()));
    if (expiryTimes.size > 1) {
      throw new PaymentInitiationError(
        'HOLD_INCONSISTENT',
        'Les blocs de hold ont des échéances différentes.',
        { statusCode: 400 },
      );
    }
  }

  // e. Répartition par ligne : chaque ligne a exactement line.quantity allocations.
  for (const line of lines) {
    const lineAllocCount = allocs.filter((a) => a.draftLineId === line.id).length;
    if (lineAllocCount !== line.quantity) {
      throw new PaymentInitiationError(
        'ALLOCATION_INCONSISTENT',
        `La ligne ${line.id} a ${lineAllocCount} allocations (attendu : ${line.quantity}).`,
        { statusCode: 400 },
      );
    }
  }

  // f. Échéance des blocs cohérente avec celle du brouillon.
  if (draft.status === 'HELD' && draft.expiresAt !== null) {
    for (const block of blocks) {
      if (block.expiresAt === null || block.expiresAt.getTime() !== draft.expiresAt.getTime()) {
        throw new PaymentInitiationError(
          'HOLD_INCONSISTENT',
          `L'échéance du bloc ${block.id} ne correspond pas à celle du brouillon.`,
          { statusCode: 400 },
        );
      }
    }
  }

  // 10. Si HELD → résoudre les termes financiers.
  // Si PAYMENT_PROCESSING (retry), le snapshot est déjà persisté dans le payment.
  let snapshot;
  if (draft.status === 'HELD') {
    try {
      snapshot = resolveFinancialTerms(
        {
          organizationId: draft.organizationId,
          draftTotalAmountMinor: draft.totalAmountMinor,
          draftCurrency: draft.currency,
        },
        input.financialTermsConfig,
        input.termsAcceptance,
      );
    } catch (error) {
      const normalized = normalizeBusinessError(error);
      if (normalized) throw normalized;
      throw error;
    }
  }

  // 11. Vérifier organization_payment_accounts.
  const accountRows = await tx
    .select()
    .from(organizationPaymentAccounts)
    .where(
      and(
        eq(organizationPaymentAccounts.organizationId, input.organizationId),
        eq(organizationPaymentAccounts.environment, input.environment),
      ),
    )
    .limit(1);

  if (accountRows.length === 0) {
    throw new PaymentInitiationError(
      'CONNECTED_ACCOUNT_NOT_FOUND',
      'Compte de paiement connecté introuvable pour cette organisation et cet environnement.',
      { statusCode: 404 },
    );
  }
  const account = accountRows[0]!;

  if (!account.chargesEnabled) {
    throw new PaymentInitiationError(
      'CONNECTED_ACCOUNT_NOT_READY',
      "Le compte connecté n'est pas autorisé à encaisser (charges désactivées).",
      { statusCode: 400 },
    );
  }
  if (account.onboardingStatus !== 'ENABLED') {
    throw new PaymentInitiationError(
      'CONNECTED_ACCOUNT_NOT_READY',
      `Le compte connecté n'a pas terminé l'onboarding (reçu : ${account.onboardingStatus}).`,
      { statusCode: 400 },
    );
  }
  if (account.transfersCapabilityStatus !== 'ACTIVE') {
    throw new PaymentInitiationError(
      'CONNECTED_ACCOUNT_TRANSFERS_INACTIVE',
      `Le compte connecté n'a pas une capacité de transfert active (reçu : ${account.transfersCapabilityStatus}).`,
      { statusCode: 400 },
    );
  }

  // 11b. Vérifier la cohérence entre le snapshot et le compte de paiement.
  if (snapshot) {
    if (snapshot.connectedAccountId !== account.providerAccountId) {
      throw new PaymentInitiationError(
        'PROVIDER_STATE_INCONSISTENT',
        "Le compte connecté du snapshot ne correspond pas au compte de paiement de l'organisation.",
        { statusCode: 500 },
      );
    }
    if (snapshot.settlementMerchantMode !== account.settlementMerchantMode) {
      throw new PaymentInitiationError(
        'PROVIDER_STATE_INCONSISTENT',
        'Le mode de settlement merchant du snapshot ne correspond pas au compte de paiement.',
        { statusCode: 500 },
      );
    }
  }

  // 12. Créer ou réutiliser le payment.
  let paymentRows = await tx
    .select()
    .from(payments)
    .where(eq(payments.draftId, input.draftId))
    .limit(1);

  if (paymentRows.length === 0) {
    // Créer le payment depuis le snapshot.
    if (!snapshot) {
      throw new PaymentInitiationError(
        'DRAFT_ALREADY_PROCESSING_INCONSISTENT',
        'Brouillon en PAYMENT_PROCESSING sans payment existant et sans snapshot.',
        { statusCode: 500 },
      );
    }
    const [created] = await tx
      .insert(payments)
      .values({
        organizationId: input.organizationId,
        draftId: input.draftId,
        customerUserId: input.customerUserId,
        status: 'PENDING_PROVIDER',
        amountMinor: snapshot.totalAmountMinor,
        currency: 'EUR',
        taxStatus: snapshot.taxStatus,
        taxAmountMinor: snapshot.taxAmountMinor,
        taxRateBps: snapshot.taxRateBps,
        taxRuleSnapshot: snapshot.taxRuleSnapshot,
        commissionAmountMinor: snapshot.commissionAmountMinor,
        commissionRuleSnapshot: snapshot.commissionRuleSnapshot,
        financialTermsVersion: snapshot.version,
        legalTermsVersion: snapshot.legalTermsVersion,
        termsAcceptanceSnapshot: input.termsAcceptance,
        connectedAccountId: snapshot.connectedAccountId,
        onBehalfOfAccountId: snapshot.onBehalfOfAccountId,
        chargeModel: 'DESTINATION',
        settlementMerchantMode: snapshot.settlementMerchantMode,
        environment: input.environment,
        processingStartedAt: sql`transaction_timestamp()`,
        processingDeadlineAt: sql`transaction_timestamp() + ${PROCESSING_DEADLINE_INTERVAL}`,
      })
      .returning();
    paymentRows = [created!];
  } else {
    // Vérifier la cohérence : montant, devise, compte connecté, commission, environnement.
    const existing = paymentRows[0]!;
    // P1-2 : vérifier que l'environnement du payment existant correspond à l'initiation.
    // Un paiement TEST ne doit jamais être réutilisé par une initiation LIVE (et inversement).
    if (existing.environment !== input.environment) {
      throw new PaymentInitiationError(
        'PROVIDER_STATE_INCONSISTENT',
        `Le payment existant est en environnement ${existing.environment} mais l'initiation demande ${input.environment}.`,
        { statusCode: 500 },
      );
    }
    if (snapshot) {
      if (
        existing.amountMinor !== snapshot.totalAmountMinor ||
        existing.currency !== 'EUR' ||
        existing.connectedAccountId !== snapshot.connectedAccountId ||
        existing.commissionAmountMinor !== snapshot.commissionAmountMinor
      ) {
        throw new PaymentInitiationError(
          'PROVIDER_STATE_INCONSISTENT',
          'Le payment existant ne correspond pas au snapshot résolu.',
          { statusCode: 500 },
        );
      }
    }
    // Vérifier la cohérence du compte connecté avec la DB.
    if (existing.connectedAccountId !== account.providerAccountId) {
      throw new PaymentInitiationError(
        'PROVIDER_STATE_INCONSISTENT',
        'Le compte connecté du payment ne correspond pas au compte de paiement configuré.',
        { statusCode: 500 },
      );
    }
  }
  const payment = paymentRows[0]!;

  // 13. Créer ou réutiliser le payment_attempt.
  let attemptRows = await tx
    .select()
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.paymentId, payment.id),
        inArray(paymentAttempts.status, [
          'PENDING_PROVIDER',
          'REQUIRES_PAYMENT_METHOD',
          'REQUIRES_ACTION',
          'PROCESSING',
        ]),
      ),
    )
    .limit(1);

  if (attemptRows.length === 0) {
    // Vérifier s'il existe une tentative terminale — si oui, ne pas en créer
    // une nouvelle. Le draft est en PAYMENT_PROCESSING avec une tentative
    // terminale : cet état doit être traité par le cron de réconciliation
    // (Phase 8), pas par la création d'une nouvelle tentative.
    const terminalAttempts = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.paymentId, payment.id),
          inArray(paymentAttempts.status, ['SUCCEEDED', 'FAILED', 'CANCELLED']),
        ),
      );
    if ((terminalAttempts[0]?.count ?? 0) > 0) {
      throw new PaymentInitiationError(
        'ATTEMPT_TERMINAL_RECONCILIATION_REQUIRED',
        'Une tentative terminale existe déjà pour ce paiement. La réconciliation est requise.',
        { statusCode: 409 },
      );
    }

    // Aucune tentative — créer la première.
    // Compter les tentatives existantes pour attempt_number.
    const existingCount = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(paymentAttempts)
      .where(eq(paymentAttempts.paymentId, payment.id));
    const attemptNumber = (existingCount[0]?.count ?? 0) + 1;

    // Générer la clé d'idempotence provider depuis l'identité de la tentative
    // (PAS depuis la clé utilisateur).
    const providerIdempotencyKey = `pi_${payment.id}_${attemptNumber}`;

    const [createdAttempt] = await tx
      .insert(paymentAttempts)
      .values({
        organizationId: input.organizationId,
        paymentId: payment.id,
        attemptNumber,
        status: 'PENDING_PROVIDER',
        providerIdempotencyKey,
        providerStatus: null,
        reconcileAfter: sql`transaction_timestamp() + ${PROCESSING_DEADLINE_INTERVAL}`,
      })
      .returning();
    attemptRows = [createdAttempt!];
  }
  const attempt = attemptRows[0]!;

  // 14. Transition : HELD → PAYMENT_PROCESSING (seulement si actuellement HELD).
  if (draft.status === 'HELD') {
    await tx
      .update(bookingDrafts)
      .set({ status: 'PAYMENT_PROCESSING', updatedAt: sql`now()` })
      .where(eq(bookingDrafts.id, input.draftId));

    // Transition de tous les blocs : ACTIVE → PAYMENT_PROCESSING.
    await tx
      .update(inventoryBlocks)
      .set({ status: 'PAYMENT_PROCESSING', updatedAt: sql`now()` })
      .where(
        and(eq(inventoryBlocks.sourceId, input.draftId), eq(inventoryBlocks.status, 'ACTIVE')),
      );
  }
  // Si déjà PAYMENT_PROCESSING (retry), on ne re-transitionne pas — juste réutiliser.

  // 15. Ne PAS modifier les allocations (elles restent ALLOCATED).

  // Retourner les données nécessaires pour l'appel provider (APRÈS commit).
  return {
    kind: 'LOCKED',
    paymentId: payment.id,
    paymentAttemptId: attempt.id,
    providerIdempotencyKey: attempt.providerIdempotencyKey,
    providerPaymentIntentId: attempt.providerPaymentIntentId,
    amountMinor: payment.amountMinor,
    connectedAccountId: payment.connectedAccountId,
    commissionAmountMinor: payment.commissionAmountMinor,
    onBehalfOfAccountId: payment.onBehalfOfAccountId,
    processingDeadlineAt: payment.processingDeadlineAt!,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transaction B — Projection du provider
// ─────────────────────────────────────────────────────────────────────────────

/** Résultat interne de Transaction B (COMPLETED ou REPLAY). */
type TransactionBOutcome =
  | {
      kind: 'COMPLETED';
      providerResult: PaymentIntentResult;
      persistedResponse: PersistedPaymentResponse;
    }
  | { kind: 'REPLAY'; record: IdempotencyRecordRow };

/**
 * Exécute la projection de la réponse du provider dans Transaction B.
 *
 * @throws PaymentInitiationError pour les erreurs de cohérence.
 * @throws Error pour les erreurs techniques.
 */
async function executeProviderProjection(
  tx: DatabaseTransaction,
  input: InitiatePaymentInput,
  reservationRecordId: string,
  txResult: TransactionAResult,
  providerResult: PaymentIntentResult,
): Promise<TransactionBOutcome> {
  // 1. Verrouiller l'enregistrement idempotent.
  const lock = await lockKey(tx, reservationRecordId);
  if (lock.kind === 'REPLAY') {
    return { kind: 'REPLAY' as const, record: lock.record };
  }

  // 2. Verrouiller dans l'ordre global : booking_draft, inventory_blocks, allocations, payment, payment_attempt.
  await lockOrganization(tx, input.organizationId);

  await tx
    .select()
    .from(bookingDrafts)
    .where(eq(bookingDrafts.id, input.draftId))
    .for('update')
    .limit(1);

  const blocks = await tx
    .select()
    .from(inventoryBlocks)
    .where(eq(inventoryBlocks.sourceId, input.draftId))
    .orderBy(inventoryBlocks.id)
    .for('update');

  const blockIds = blocks.map((b) => b.id);
  await tx
    .select()
    .from(allocations)
    .where(inArray(allocations.inventoryBlockId, blockIds))
    .orderBy(allocations.id)
    .for('update');

  const paymentRows = await tx
    .select()
    .from(payments)
    .where(eq(payments.id, txResult.paymentId))
    .for('update')
    .limit(1);

  if (paymentRows.length === 0) {
    throw new PaymentInitiationError(
      'PROVIDER_STATE_INCONSISTENT',
      'Payment introuvable lors de la projection du provider.',
      { statusCode: 500 },
    );
  }
  const payment = paymentRows[0]!;

  const attemptRows = await tx
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.id, txResult.paymentAttemptId))
    .for('update')
    .limit(1);

  if (attemptRows.length === 0) {
    throw new PaymentInitiationError(
      'PROVIDER_STATE_INCONSISTENT',
      'Payment attempt introuvable lors de la projection du provider.',
      { statusCode: 500 },
    );
  }
  const attempt = attemptRows[0]!;

  // 3. Re-vérifier la cohérence : organisation, montants, devise, tentative, ID provider.
  if (payment.organizationId !== input.organizationId) {
    throw new PaymentInitiationError(
      'PROVIDER_STATE_INCONSISTENT',
      "L'organisation du payment ne correspond pas au contexte.",
      { statusCode: 500 },
    );
  }
  if (payment.amountMinor !== txResult.amountMinor) {
    throw new PaymentInitiationError(
      'PROVIDER_STATE_INCONSISTENT',
      'Le montant du payment a changé entre la transaction A et B.',
      { statusCode: 500 },
    );
  }
  if (payment.currency !== 'EUR') {
    throw new PaymentInitiationError(
      'PROVIDER_STATE_INCONSISTENT',
      "La devise du payment n'est pas EUR.",
      { statusCode: 500 },
    );
  }
  if (attempt.paymentId !== payment.id) {
    throw new PaymentInitiationError(
      'PROVIDER_STATE_INCONSISTENT',
      "L'attempt ne correspond pas au payment.",
      { statusCode: 500 },
    );
  }

  // 3b. Vérifier la cohérence de la réponse fournisseur avec l'état courant verrouillé.
  if (
    attempt.providerPaymentIntentId !== null &&
    providerResult.id !== attempt.providerPaymentIntentId
  ) {
    throw new PaymentInitiationError(
      'PROVIDER_STATE_INCONSISTENT',
      "L'identifiant du PaymentIntent retourné par le provider ne correspond pas à l'identifiant verrouillé.",
      { statusCode: 500 },
    );
  }
  if (providerResult.amountMinor !== payment.amountMinor) {
    throw new PaymentInitiationError(
      'PROVIDER_STATE_INCONSISTENT',
      'Le montant du PaymentIntent ne correspond pas au montant persisté.',
      { statusCode: 500 },
    );
  }
  if (providerResult.currency !== 'EUR') {
    throw new PaymentInitiationError(
      'PROVIDER_STATE_INCONSISTENT',
      'La devise du PaymentIntent ne correspond pas à EUR.',
      { statusCode: 500 },
    );
  }

  // 3c. Vérifier la cohérence financière complète de la réponse fournisseur.
  if (providerResult.environment !== input.environment) {
    throw new PaymentInitiationError(
      'PROVIDER_STATE_INCONSISTENT',
      "L'environnement du PaymentIntent ne correspond pas au contexte.",
      { statusCode: 500 },
    );
  }
  // Pour une destination charge Uttuly, l'absence de destination est une anomalie bloquante.
  if (providerResult.connectedAccountId === null) {
    throw new PaymentInitiationError(
      'PROVIDER_STATE_INCONSISTENT',
      "Le PaymentIntent n'a pas de transfer_data.destination (destination charge invalide).",
      { statusCode: 500 },
    );
  }
  if (providerResult.connectedAccountId !== payment.connectedAccountId) {
    throw new PaymentInitiationError(
      'PROVIDER_STATE_INCONSISTENT',
      'Le compte connecté du PaymentIntent ne correspond pas au payment persisté.',
      { statusCode: 500 },
    );
  }
  // Accepter null OU 0 lorsque la commission est 0 (Stripe peut retourner soit).
  const expectedFee = txResult.commissionAmountMinor === 0 ? null : txResult.commissionAmountMinor;
  if (
    providerResult.applicationFeeAmountMinor !== expectedFee &&
    !(expectedFee === null && providerResult.applicationFeeAmountMinor === 0)
  ) {
    throw new PaymentInitiationError(
      'PROVIDER_STATE_INCONSISTENT',
      'La commission du PaymentIntent ne correspond pas au payment persisté.',
      { statusCode: 500 },
    );
  }
  if (providerResult.onBehalfOfAccountId !== txResult.onBehalfOfAccountId) {
    throw new PaymentInitiationError(
      'PROVIDER_STATE_INCONSISTENT',
      'Le on_behalf_of du PaymentIntent ne correspond pas au payment persisté.',
      { statusCode: 500 },
    );
  }

  // 4. Persister la projection du provider — monotone, pas de régression.
  // Le webhook est l'AUTORITÉ pour les statuts terminaux (SUCCEEDED, FAILED, CANCELLED).
  // Transaction B ne projette JAMAIS un statut terminal sur attempt.status ou payments.status.
  // Elle ne projette que les statuts non terminaux (REQUIRES_PAYMENT_METHOD, REQUIRES_ACTION, PROCESSING).
  const mappedStatus = mapProviderStatusToLocal(providerResult.status);
  const terminalStatuses = ['SUCCEEDED', 'FAILED', 'CANCELLED'];
  const nonTerminalMappedStatus = terminalStatuses.includes(mappedStatus) ? null : mappedStatus;

  // 3d. Incohérence d'agrégat : payment et attempt doivent être synchronisés.
  // Le webhook projette les deux ensemble — toute asymétrie est une anomalie.
  const paymentTerminal = terminalStatuses.includes(payment.status);
  const attemptTerminal = terminalStatuses.includes(attempt.status);
  if (paymentTerminal !== attemptTerminal) {
    throw new PaymentInitiationError(
      'PROVIDER_STATE_INCONSISTENT',
      paymentTerminal
        ? "Incohérence d'agrégat : payment terminal mais tentative non terminale."
        : "Incohérence d'agrégat : tentative terminale mais payment non terminal.",
      { statusCode: 500 },
    );
  }

  // Garde monotone : si l'attempt est déjà terminal (webhook concurrent), ne modifier
  // NI status NI providerStatus NI providerPaymentIntentId — la projection du webhook
  // est autoritaire. Comparer l'identifiant courant au lieu d'écraser.
  if (terminalStatuses.includes(attempt.status)) {
    // Vérifier que l'identifiant provider correspond (ne pas écraser).
    if (
      attempt.providerPaymentIntentId !== null &&
      attempt.providerPaymentIntentId !== providerResult.id
    ) {
      throw new PaymentInitiationError(
        'PROVIDER_STATE_INCONSISTENT',
        "L'identifiant du PaymentIntent ne correspond pas à l'identifiant déjà projeté par le webhook.",
        { statusCode: 500 },
      );
    }
    // Ne rien écrire sur l'attempt — le webhook a déjà projeté.
  } else if (nonTerminalMappedStatus !== null) {
    // Attempt non terminal ET mapped status non terminal → projeter normalement.
    await tx
      .update(paymentAttempts)
      .set({
        providerPaymentIntentId: providerResult.id,
        providerLatestChargeId: providerResult.latestChargeId,
        providerStatus: providerResult.status,
        status: nonTerminalMappedStatus,
        updatedAt: sql`now()`,
      })
      .where(eq(paymentAttempts.id, txResult.paymentAttemptId));

    // Mettre à jour payments.status si non terminal ET si payments n'est pas déjà terminal.
    if (!terminalStatuses.includes(payment.status)) {
      await tx
        .update(payments)
        .set({ status: nonTerminalMappedStatus, updatedAt: sql`now()` })
        .where(eq(payments.id, txResult.paymentId));
    }
  } else {
    // mappedStatus est terminal (succeeded/canceled) mais l'attempt n'est pas terminal.
    // Ne PAS projeter le statut terminal — le webhook le fera.
    // Mettre à jour uniquement les champs factuels du provider (ID, charge, providerStatus).
    await tx
      .update(paymentAttempts)
      .set({
        providerPaymentIntentId: providerResult.id,
        providerLatestChargeId: providerResult.latestChargeId,
        providerStatus: providerResult.status,
        updatedAt: sql`now()`,
      })
      .where(eq(paymentAttempts.id, txResult.paymentAttemptId));
    // Ne PAS mettre à jour payments.status — le webhook le fera.
  }

  // 5. Ne PAS créer de réservation.
  // 6. Un statut provider succeeded ne confirme PAS localement — le webhook est l'autorité.

  // 6b. Valider le clientSecret AVANT de marquer COMPLETED.
  // Si le clientSecret est null, on ne peut pas persister un succès 200.
  // Erreur technique (transient) : lancer une Error non-PaymentInitiationError
  // pour que normalizeBusinessError retourne null → rollback complet →
  // l'idempotency reste PENDING (récupérable par retry).
  if (providerResult.clientSecret === null) {
    throw new Error(
      "Le provider n'a pas retourné de client_secret. L'opération est récupérable par retry.",
    );
  }

  // 7. Marquer l'enregistrement idempotent COMPLETED avec la réponse expurgée (SANS clientSecret).
  const persistedResponse: PersistedPaymentResponse = {
    paymentId: txResult.paymentId,
    paymentAttemptId: txResult.paymentAttemptId,
    providerPaymentIntentId: providerResult.id,
    providerStatus: providerResult.status,
    processingDeadlineAt: txResult.processingDeadlineAt.toISOString(),
  };

  await completeKey(tx, reservationRecordId, {
    resourceId: txResult.paymentId,
    responseStatusCode: 200,
    responseBody: persistedResponse,
  });

  return { kind: 'COMPLETED' as const, providerResult, persistedResponse };
}

// ─────────────────────────────────────────────────────────────────────────────
// Replay
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gère le replay d'un enregistrement idempotent terminal (COMPLETED ou FAILED).
 *
 * Pour un COMPLETED :
 * - Décode la réponse persistée (PersistedPaymentResponse, SANS clientSecret).
 * - Récupère le PaymentIntent courant depuis le provider HORS transaction
 *   pour obtenir un clientSecret frais.
 * - Retourne un résultat REPLAY avec le clientSecret frais.
 * - Le clientSecret n'est JAMAIS lu depuis idempotency_records (il n'y est pas).
 *
 * Pour un FAILED :
 * - Retourne le FAILURE persisté tel quel.
 */
async function handleReplay(
  deps: InitiatePaymentDependencies,
  record: IdempotencyRecordRow,
): Promise<InitiatePaymentResult> {
  if (record.status === 'FAILED') {
    const body = record.responseBody as { error: string; message: string };
    return {
      kind: 'FAILURE',
      statusCode: record.responseStatusCode ?? 500,
      error: body.error,
      message: body.message,
    };
  }

  // COMPLETED.
  const persisted = record.responseBody as PersistedPaymentResponse;

  // Récupérer le PaymentIntent courant depuis le provider HORS transaction
  // pour obtenir un clientSecret frais.
  const intent = await deps.provider.retrievePaymentIntent(persisted.providerPaymentIntentId);

  if (intent.clientSecret === null) {
    throw new PaymentInitiationError(
      'PROVIDER_STATE_INCONSISTENT',
      "Le provider n'a pas retourné de client_secret lors du replay.",
      { statusCode: 500 },
    );
  }

  return {
    kind: 'REPLAY',
    statusCode: 200,
    paymentId: persisted.paymentId,
    paymentAttemptId: persisted.paymentAttemptId,
    providerPaymentIntentId: persisted.providerPaymentIntentId,
    providerStatus: intent.status,
    clientSecret: intent.clientSecret, // frais depuis le provider, jamais depuis la DB
    processingDeadlineAt: new Date(persisted.processingDeadlineAt),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initie un paiement pour un brouillon HELD.
 *
 * Étapes :
 *  0. Validation de l'entrée.
 *  1. Calcul de l'empreinte et reserveKey.
 *  2. Transaction A : prise de contrôle locale (lockKey + savepoint + logique métier).
 *  3. Appel provider HORS transaction (create ou retrieve PaymentIntent).
 *  4. Transaction B : projection de la réponse du provider (lockKey + savepoint + completeKey).
 *  5. Retour du résultat (SUCCESS avec clientSecret éphémère).
 *
 * @param deps dépendances injectées (db + provider)
 * @param input entrée sémantique (organizationId et customerUserId depuis le contexte serveur)
 * @returns résultat union discriminée SUCCESS | REPLAY | FAILURE
 */
export async function initiatePayment(
  deps: InitiatePaymentDependencies,
  input: InitiatePaymentInput,
): Promise<InitiatePaymentResult> {
  // ── Étape 0 — Validation initiale (avant la base) ──────────────────────
  validateInput(input);

  // ── Étape 1 — Calcul de l'empreinte et reserveKey ──────────────────────
  const fingerprint = computePaymentFingerprint({
    organizationId: input.organizationId,
    customerUserId: input.customerUserId,
    draftId: input.draftId,
    environment: input.environment,
    termsVersion: input.termsAcceptance.termsVersion,
  });

  const reservation = await reserveKey(deps.db, {
    organizationId: input.organizationId,
    operation: INITIATE_PAYMENT_OPERATION,
    key: input.idempotencyKey,
    requestFingerprint: fingerprint,
  });

  if (reservation.kind === 'CONFLICT') {
    throw new PaymentInitiationError(
      'IDEMPOTENCY_CONFLICT',
      "Clé d'idempotence réutilisée avec une empreinte différente.",
      { statusCode: 409 },
    );
  }

  if (reservation.kind === 'REPLAY') {
    // COMPLETED ou FAILED — gérer le replay.
    return handleReplay(deps, reservation.record);
  }

  // ACQUIRED ou PENDING → procéder à la Transaction A.

  // ── Étape 2 — Transaction A : prise de contrôle locale ─────────────────
  //
  // ADR-009 §11 étape 4 : les erreurs métier prévues sont capturées dans un
  // SAVEPOINT de la transaction externe qui conserve le verrou sur
  // l'enregistrement PENDING. Le savepoint est annulé (ROLLBACK TO SAVEPOINT),
  // puis l'enregistrement est mis à jour en FAILED, et la transaction externe
  // est committée.
  const txAOutcome: TransactionAOutcome | InitiatePaymentFailure = await deps.db.transaction(
    async (tx) => {
      const lock = await lockKey(tx, reservation.record.id);
      if (lock.kind === 'REPLAY') {
        return { kind: 'REPLAY' as const, record: lock.record };
      }
      // LOCKED — exécuter la logique métier dans un savepoint imbriqué.
      try {
        const result = await tx.transaction(async (sp) => {
          return await executeTakeover(sp, input);
        });
        return result;
      } catch (error) {
        // Le savepoint a été automatiquement annulé par postgres.js.
        // La transaction externe (tx) est intacte et le verrou idempotent est
        // conservé : on peut persister l'échec métier via failKey.
        const businessError = normalizeBusinessError(error);
        if (businessError === null) {
          // Erreur technique inattendue : rollback complet, idempotency reste PENDING.
          throw error;
        }

        await failKey(tx, reservation.record.id, {
          responseStatusCode: businessError.statusCode,
          responseBody: businessError.responseBody,
        });

        const failure: InitiatePaymentFailure = {
          kind: 'FAILURE',
          statusCode: businessError.statusCode,
          error: businessError.responseBody.error,
          message: businessError.responseBody.message,
        };
        return failure;
      }
    },
  );

  // Si Transaction A a retourné un REPLAY (une autre requête a terminé pendant que nous attendions).
  if ('kind' in txAOutcome && txAOutcome.kind === 'REPLAY') {
    return handleReplay(
      deps,
      (txAOutcome as { kind: 'REPLAY'; record: IdempotencyRecordRow }).record,
    );
  }

  // Si Transaction A a retourné un FAILURE (erreur métier persistée).
  if ('kind' in txAOutcome && txAOutcome.kind === 'FAILURE') {
    return txAOutcome as InitiatePaymentFailure;
  }

  // LOCKED — Transaction A a commité avec succès.
  const txResult = txAOutcome as TransactionAResult;

  // ── Étape 3 — Appel provider HORS transaction ──────────────────────────
  //
  // IMPORTANT : aucun appel Stripe à l'intérieur d'une transaction PostgreSQL.
  // Le PaymentIntent est construit UNIQUEMENT depuis les données persistées.
  const params: CreatePaymentIntentParams = {
    amountMinor: txResult.amountMinor,
    currency: 'EUR',
    connectedAccountId: txResult.connectedAccountId,
    applicationFeeAmountMinor:
      txResult.commissionAmountMinor === 0 ? null : txResult.commissionAmountMinor,
    onBehalfOfAccountId: txResult.onBehalfOfAccountId,
    idempotencyKey: txResult.providerIdempotencyKey,
    metadata: {
      payment_id: txResult.paymentId,
      payment_attempt_id: txResult.paymentAttemptId,
      draft_id: input.draftId,
      organization_id: input.organizationId,
      protocol_version: PAYMENT_PROTOCOL_VERSION,
    },
  };

  let providerResult: PaymentIntentResult;
  try {
    if (txResult.providerPaymentIntentId) {
      // Retry avec un intent existant — retrieve, pas create.
      providerResult = await deps.provider.retrievePaymentIntent(txResult.providerPaymentIntentId);
    } else {
      // Créer un nouveau PaymentIntent.
      providerResult = await deps.provider.createPaymentIntent(params);
    }
  } catch (error) {
    // Ne PAS relâcher les holds.
    // Ne PAS créer une seconde tentative.
    // Ne PAS marquer FAILED si un PaymentIntent pourrait exister.
    // L'enregistrement idempotent reste PENDING (récupérable par retry).
    // Ne PAS exposer le message arbitraire du provider au client.
    // Conserver uniquement un code fermé et un message local.
    if (error instanceof PaymentProviderError) {
      throw new PaymentInitiationError(
        'PROVIDER_CALL_FAILED',
        "Échec de l'appel au fournisseur de paiement. L'opération est récupérable par retry.",
        { statusCode: 502 },
      );
    }
    throw new PaymentInitiationError(
      'PROVIDER_CALL_FAILED',
      "Échec de l'appel au fournisseur de paiement. L'opération est récupérable par retry.",
      { statusCode: 502 },
    );
  }

  // ── Étape 4 — Transaction B : projection du provider ───────────────────
  const finalResult: TransactionBOutcome | InitiatePaymentFailure = await deps.db.transaction(
    async (tx) => {
      const lock = await lockKey(tx, reservation.record.id);
      if (lock.kind === 'REPLAY') {
        return { kind: 'REPLAY' as const, record: lock.record };
      }
      // LOCKED — exécuter la projection dans un savepoint imbriqué.
      try {
        const result = await tx.transaction(async (sp) => {
          return await executeProviderProjection(
            sp,
            input,
            reservation.record.id,
            txResult,
            providerResult,
          );
        });
        return result;
      } catch (error) {
        // Le savepoint a été automatiquement annulé par postgres.js.
        const businessError = normalizeBusinessError(error);
        if (businessError === null) {
          // Erreur technique inattendue : rollback complet, idempotency reste PENDING.
          throw error;
        }

        await failKey(tx, reservation.record.id, {
          responseStatusCode: businessError.statusCode,
          responseBody: businessError.responseBody,
        });

        const failure: InitiatePaymentFailure = {
          kind: 'FAILURE',
          statusCode: businessError.statusCode,
          error: businessError.responseBody.error,
          message: businessError.responseBody.message,
        };
        return failure;
      }
    },
  );

  // Si Transaction B a retourné un REPLAY.
  if ('kind' in finalResult && finalResult.kind === 'REPLAY') {
    return handleReplay(
      deps,
      (finalResult as { kind: 'REPLAY'; record: IdempotencyRecordRow }).record,
    );
  }

  // Si Transaction B a retourné un FAILURE.
  if ('kind' in finalResult && finalResult.kind === 'FAILURE') {
    return finalResult as InitiatePaymentFailure;
  }

  // COMPLETED — Transaction B a commité avec succès.
  const completed = finalResult as {
    kind: 'COMPLETED';
    providerResult: PaymentIntentResult;
    persistedResponse: PersistedPaymentResponse;
  };

  // ── Étape 5 — Retour du résultat ───────────────────────────────────────
  // Le clientSecret a été validé non-null dans Transaction B (avant completeKey).
  return {
    kind: 'SUCCESS',
    statusCode: 200,
    paymentId: completed.persistedResponse.paymentId,
    paymentAttemptId: completed.persistedResponse.paymentAttemptId,
    providerPaymentIntentId: completed.persistedResponse.providerPaymentIntentId,
    providerStatus: completed.providerResult.status,
    clientSecret: completed.providerResult.clientSecret as string, // validé non-null dans Transaction B
    processingDeadlineAt: new Date(completed.persistedResponse.processingDeadlineAt),
  };
}
