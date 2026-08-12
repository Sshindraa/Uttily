/**
 * @uttily/core — Projection canonique getEffectiveBooking (G7M-B1, ADR-023 §4.1, §11.1).
 *
 * L'unique autorité de lecture pour l'état effectif d'une réservation :
 *
 * - Booking original si aucun amendement APPLIED n'existe.
 * - Dernier snapshot complet APPLIED sinon (les amendements sont ordonnés
 *   par amendment_number, puis id pour déterminisme).
 * - Projection financière complète : six métriques agrégées depuis deux origines
 *   (paiement initial + amendment_payments) sans produit cartésien.
 *
 * Tenant-safe : une réservation appartenant à une autre organisation produit
 * exactement NOT_FOUND, sans révéler son existence. La requête racine est
 * tenant-scoped (bookings.id + bookings.organization_id) ; les tables G7M-A
 * portant organization_id sont filtrées de manière redondante.
 *
 * Read-only : aucune mutation, aucune transaction interne. Accepte DbExecutor
 * (DatabaseClient ou DatabaseTransaction) afin que G7M-B2 puisse l'appeler
 * dans sa propre transaction.
 */

import { and, asc, eq, inArray, ne, sum } from 'drizzle-orm';
import type { DbExecutor } from '@uttily/database';
import {
  amendmentPayments,
  bookings,
  bookingAmendmentAllocations,
  bookingAmendmentLines,
  bookingAmendments,
  bookingItems,
  bookingLines,
  inventoryBlocks,
  payments,
  refunds,
} from '@uttily/database';
import { EffectiveBookingError } from './errors';
import type {
  AmendmentSummary,
  EffectiveAllocation,
  EffectiveFinancials,
  EffectiveLine,
  FinancialSnapshot,
  GetEffectiveBookingResult,
} from './types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_SAFE_INTEGER = 9007199254740991;

function assertUuid(value: string, field: string): void {
  if (!UUID_REGEX.test(value)) {
    throw new EffectiveBookingError('VALIDATION', `${field} invalide (UUID attendu).`);
  }
}

/**
 * Vérifie l'invariant financier ADR-023 §11.2 :
 *   grossCollected - successfulRefunded - settledOffPlatform - refundStillOwed = contractualTotal
 *
 * Utilise BigInt pour une comparaison sans perte. Valide d'abord que chaque
 * montant est un entier sûr non-négatif (≤ MAX_SAFE_INTEGER). En cas de
 * violation, lève EffectiveBookingError('FINANCIAL_INVARIANT_VIOLATION') avec
 * les cinq montants pour diagnostic (aucune PII ni donnée provider).
 *
 * Exporté uniquement pour les tests unitaires colocalisés — non exposé
 * depuis le barrel public @uttily/core.
 */
export function assertFinancialInvariant(
  grossCollected: number,
  successfulRefunded: number,
  settledOffPlatform: number,
  refundStillOwed: number,
  contractualTotal: number,
): void {
  const amounts: ReadonlyArray<[string, number]> = [
    ['grossCollected', grossCollected],
    ['successfulRefunded', successfulRefunded],
    ['settledOffPlatform', settledOffPlatform],
    ['refundStillOwed', refundStillOwed],
    ['contractualTotal', contractualTotal],
  ];
  for (const [label, value] of amounts) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_SAFE_INTEGER) {
      throw new EffectiveBookingError(
        'FINANCIAL_INVARIANT_VIOLATION',
        `Invariant financier : ${label}=${value} n'est pas un entier sûr non-négatif ` +
          `(grossCollected=${grossCollected}, successfulRefunded=${successfulRefunded}, ` +
          `settledOffPlatform=${settledOffPlatform}, refundStillOwed=${refundStillOwed}, ` +
          `contractualTotal=${contractualTotal}).`,
      );
    }
  }
  const balance =
    BigInt(grossCollected) -
    BigInt(successfulRefunded) -
    BigInt(settledOffPlatform) -
    BigInt(refundStillOwed);
  if (balance !== BigInt(contractualTotal)) {
    throw new EffectiveBookingError(
      'FINANCIAL_INVARIANT_VIOLATION',
      `Invariant financier violé : grossCollected(${grossCollected}) - ` +
        `successfulRefunded(${successfulRefunded}) - settledOffPlatform(${settledOffPlatform}) - ` +
        `refundStillOwed(${refundStillOwed}) = ${balance.toString()}, ` +
        `contractualTotal=${contractualTotal} attendu.`,
    );
  }
}

/**
 * Valide qu'un montant agrégé est un entier sûr non-négatif.
 * Les agrégations SUM PostgreSQL retournent null si aucune ligne — normalisé en 0.
 * Les colonnes bigint de drizzle-orm retournent string — converti en number.
 */
export function normalizeAggregateAmount(raw: number | string | null, context: string): number {
  if (raw === null) {
    return 0;
  }
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isInteger(value)) {
    throw new EffectiveBookingError(
      'SNAPSHOT_INVALID',
      `${context}: montant agrégé non-entier (${value}).`,
    );
  }
  if (value < 0) {
    throw new EffectiveBookingError(
      'SNAPSHOT_INVALID',
      `${context}: montant agrégé négatif (${value}).`,
    );
  }
  if (value > MAX_SAFE_INTEGER) {
    throw new EffectiveBookingError(
      'SNAPSHOT_INVALID',
      `${context}: montant agrégé dépasse MAX_SAFE_INTEGER (${value}).`,
    );
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing du snapshot financier JSONB (ADR-023 §4.1, §11)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse et valide un financial_snapshot_after JSONB.
 *
 * Le snapshot doit contenir au minimum :
 * - totalAmountMinor : entier sûr non-négatif
 * - currency : string non-vide (EUR uniquement, ADR-023 §2.1)
 *
 * Échoue avec SNAPSHOT_INVALID si les données persistées sont invalides.
 * Ne retourne jamais NaN ou un snapshot partiel silencieux.
 *
 * Exporté uniquement pour les tests unitaires colocalisés — non exposé
 * depuis le barrel public @uttily/core.
 */
export function parseFinancialSnapshot(raw: unknown, context: string): FinancialSnapshot {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new EffectiveBookingError(
      'SNAPSHOT_INVALID',
      `${context}: le snapshot financier n'est pas un objet JSON valide.`,
    );
  }

  const obj = raw as Record<string, unknown>;

  const totalAmountMinor = obj['totalAmountMinor'];
  if (typeof totalAmountMinor !== 'number' || !Number.isInteger(totalAmountMinor)) {
    throw new EffectiveBookingError(
      'SNAPSHOT_INVALID',
      `${context}: totalAmountMinor n'est pas un entier.`,
    );
  }
  if (totalAmountMinor < 0) {
    throw new EffectiveBookingError(
      'SNAPSHOT_INVALID',
      `${context}: totalAmountMinor est négatif (${totalAmountMinor}).`,
    );
  }
  if (totalAmountMinor > MAX_SAFE_INTEGER) {
    throw new EffectiveBookingError(
      'SNAPSHOT_INVALID',
      `${context}: totalAmountMinor dépasse MAX_SAFE_INTEGER (${totalAmountMinor}).`,
    );
  }

  const currency = obj['currency'];
  if (typeof currency !== 'string' || currency.length === 0) {
    throw new EffectiveBookingError(
      'SNAPSHOT_INVALID',
      `${context}: currency est manquante ou vide.`,
    );
  }
  if (currency !== 'EUR') {
    throw new EffectiveBookingError(
      'SNAPSHOT_INVALID',
      `${context}: currency invalide (${currency}), EUR attendu.`,
    );
  }

  return { totalAmountMinor, currency };
}

// ─────────────────────────────────────────────────────────────────────────────
// Projection principale
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retourne l'état contractuel effectif d'une réservation.
 *
 * @param db Exécuteur DB abstrait (DatabaseClient ou DatabaseTransaction).
 * @param organizationId UUID de l'organisation (tenant).
 * @param bookingId UUID de la réservation.
 * @returns FOUND avec la projection, ou NOT_FOUND (tenant-safe).
 * @throws EffectiveBookingError pour les entrées invalides ou les snapshots corrompus.
 */
export async function getEffectiveBooking(
  db: DbExecutor,
  organizationId: string,
  bookingId: string,
): Promise<GetEffectiveBookingResult> {
  assertUuid(organizationId, 'organizationId');
  assertUuid(bookingId, 'bookingId');

  // 1. Charger la booking avec les deux prédicats (tenant-safe).
  const bookingRows = await db
    .select({
      id: bookings.id,
      organizationId: bookings.organizationId,
      status: bookings.status,
      customerUserId: bookings.customerUserId,
      locationId: bookings.locationId,
      timezone: bookings.timezone,
      paymentId: bookings.paymentId,
      customerStartAt: bookings.customerStartAt,
      customerEndAt: bookings.customerEndAt,
      blockedStartAt: bookings.blockedStartAt,
      blockedEndAt: bookings.blockedEndAt,
      totalAmountMinor: bookings.totalAmountMinor,
      currency: bookings.currency,
    })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.organizationId, organizationId)))
    .limit(1);

  if (bookingRows.length === 0) {
    return { kind: 'NOT_FOUND' };
  }

  const booking = bookingRows[0]!;

  // 2. Charger les amendements APPLIED, ordre déterministe.
  const appliedAmendments = await db
    .select({
      id: bookingAmendments.id,
      amendmentNumber: bookingAmendments.amendmentNumber,
      type: bookingAmendments.type,
      financialSnapshotAfter: bookingAmendments.financialSnapshotAfter,
      newCustomerStartAt: bookingAmendments.newCustomerStartAt,
      newCustomerEndAt: bookingAmendments.newCustomerEndAt,
      newBlockedStartAt: bookingAmendments.newBlockedStartAt,
      newBlockedEndAt: bookingAmendments.newBlockedEndAt,
      appliedAt: bookingAmendments.appliedAt,
    })
    .from(bookingAmendments)
    .where(
      and(
        eq(bookingAmendments.bookingId, bookingId),
        eq(bookingAmendments.organizationId, organizationId),
        eq(bookingAmendments.status, 'APPLIED'),
      ),
    )
    .orderBy(asc(bookingAmendments.amendmentNumber), asc(bookingAmendments.id));

  // 3. Déterminer le total contractuel effectif et les dates effectives.
  let contractualTotalAmountMinor: number;
  let effectiveCurrency: string;
  let effectiveCustomerStartAt: Date;
  let effectiveCustomerEndAt: Date;
  let effectiveBlockedStartAt: Date;
  let effectiveBlockedEndAt: Date;

  if (appliedAmendments.length === 0) {
    contractualTotalAmountMinor = booking.totalAmountMinor;
    effectiveCurrency = booking.currency;
    effectiveCustomerStartAt = booking.customerStartAt;
    effectiveCustomerEndAt = booking.customerEndAt;
    effectiveBlockedStartAt = booking.blockedStartAt;
    effectiveBlockedEndAt = booking.blockedEndAt;
  } else {
    const lastApplied = appliedAmendments[appliedAmendments.length - 1]!;
    const snapshot = parseFinancialSnapshot(
      lastApplied.financialSnapshotAfter,
      `amendment ${lastApplied.amendmentNumber}`,
    );
    contractualTotalAmountMinor = snapshot.totalAmountMinor;
    effectiveCurrency = snapshot.currency;
    effectiveCustomerStartAt = lastApplied.newCustomerStartAt;
    effectiveCustomerEndAt = lastApplied.newCustomerEndAt;
    effectiveBlockedStartAt = lastApplied.newBlockedStartAt;
    effectiveBlockedEndAt = lastApplied.newBlockedEndAt;
  }

  // 4. Charger les lignes, allocations et financials en parallèle.
  const [lines, allocations, financials] = await Promise.all([
    appliedAmendments.length === 0
      ? loadOriginalLines(db, bookingId)
      : loadAmendmentLines(db, appliedAmendments[appliedAmendments.length - 1]!.id, organizationId),
    appliedAmendments.length === 0
      ? loadOriginalAllocations(db, bookingId)
      : loadAmendmentAllocations(
          db,
          appliedAmendments[appliedAmendments.length - 1]!.id,
          organizationId,
        ),
    loadFinancials(db, organizationId, bookingId, booking.paymentId, contractualTotalAmountMinor),
  ]);

  // 5. Historique ordonné.
  const amendments: AmendmentSummary[] = appliedAmendments.map((a) => ({
    id: a.id,
    amendmentNumber: a.amendmentNumber,
    type: a.type,
    appliedAt: a.appliedAt!,
  }));

  return {
    kind: 'FOUND',
    booking: {
      booking: {
        id: booking.id,
        organizationId: booking.organizationId,
        status: booking.status,
        customerUserId: booking.customerUserId,
        locationId: booking.locationId,
        timezone: booking.timezone,
      },
      effectiveCustomerStartAt,
      effectiveCustomerEndAt,
      effectiveBlockedStartAt,
      effectiveBlockedEndAt,
      effectiveTotalAmountMinor: contractualTotalAmountMinor,
      effectiveCurrency,
      financials,
      lines,
      allocations,
      lastAppliedAmendmentNumber:
        appliedAmendments.length === 0
          ? 0
          : appliedAmendments[appliedAmendments.length - 1]!.amendmentNumber,
      amendments,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Loaders — lignes et allocations originales
// ─────────────────────────────────────────────────────────────────────────────

async function loadOriginalLines(db: DbExecutor, bookingId: string): Promise<EffectiveLine[]> {
  const rows = await db
    .select({
      id: bookingLines.id,
      variantId: bookingLines.variantId,
      quantity: bookingLines.quantity,
      unitPriceAmountMinor: bookingLines.unitPriceAmountMinor,
      lineTotalAmountMinor: bookingLines.lineTotalAmountMinor,
      variantSnapshot: bookingLines.variantSnapshot,
    })
    .from(bookingLines)
    .where(eq(bookingLines.bookingId, bookingId))
    .orderBy(asc(bookingLines.id));

  return rows.map((r) => ({
    id: r.id,
    logicalLineId: r.id, // Pour une ligne originale, logical_line_id = booking_line.id (ADR §3.5)
    variantId: r.variantId,
    action: 'UNCHANGED' as const,
    originType: 'ORIGINAL' as const,
    sourceBookingLineId: r.id,
    quantity: r.quantity,
    unitPriceAmountMinor: r.unitPriceAmountMinor,
    lineTotalAmountMinor: r.lineTotalAmountMinor,
    variantSnapshot: r.variantSnapshot,
  }));
}

async function loadOriginalAllocations(
  db: DbExecutor,
  bookingId: string,
): Promise<EffectiveAllocation[]> {
  const itemRows = await db
    .select({
      id: bookingItems.id,
      bookingLineId: bookingItems.bookingLineId,
      inventoryItemId: bookingItems.inventoryItemId,
      bookingBlockId: bookingItems.bookingBlockId,
    })
    .from(bookingItems)
    .where(eq(bookingItems.bookingId, bookingId))
    .orderBy(
      asc(bookingItems.bookingLineId),
      asc(bookingItems.inventoryItemId),
      asc(bookingItems.id),
    );

  if (itemRows.length === 0) return [];

  const blockIds = itemRows.map((r) => r.bookingBlockId);
  const blocks = await db
    .select({
      id: inventoryBlocks.id,
      customerStartAt: inventoryBlocks.customerStartAt,
      customerEndAt: inventoryBlocks.customerEndAt,
      blockedStartAt: inventoryBlocks.blockedStartAt,
      blockedEndAt: inventoryBlocks.blockedEndAt,
    })
    .from(inventoryBlocks)
    .where(inArray(inventoryBlocks.id, blockIds));

  const blockMap = new Map(blocks.map((b) => [b.id, b]));

  return itemRows.map((r) => {
    const block = blockMap.get(r.bookingBlockId);
    if (!block) {
      throw new EffectiveBookingError(
        'SNAPSHOT_INVALID',
        `Block ${r.bookingBlockId} introuvable pour le booking_item ${r.id}.`,
      );
    }
    return {
      id: r.id,
      logicalLineId: r.bookingLineId, // Projection originale : logicalLineId = booking_line_id
      inventoryItemId: r.inventoryItemId,
      action: 'RETAIN' as const,
      effectiveCustomerStartAt: block.customerStartAt,
      effectiveCustomerEndAt: block.customerEndAt,
      effectiveBlockedStartAt: block.blockedStartAt,
      effectiveBlockedEndAt: block.blockedEndAt,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Loaders — lignes et allocations d'amendement
// ─────────────────────────────────────────────────────────────────────────────

async function loadAmendmentLines(
  db: DbExecutor,
  amendmentId: string,
  organizationId: string,
): Promise<EffectiveLine[]> {
  const rows = await db
    .select({
      id: bookingAmendmentLines.id,
      logicalLineId: bookingAmendmentLines.logicalLineId,
      originType: bookingAmendmentLines.originType,
      sourceBookingLineId: bookingAmendmentLines.sourceBookingLineId,
      variantId: bookingAmendmentLines.variantId,
      action: bookingAmendmentLines.action,
      afterQuantity: bookingAmendmentLines.afterQuantity,
      afterUnitPriceAmountMinor: bookingAmendmentLines.afterUnitPriceAmountMinor,
      afterLineTotalAmountMinor: bookingAmendmentLines.afterLineTotalAmountMinor,
      variantSnapshot: bookingAmendmentLines.variantSnapshot,
    })
    .from(bookingAmendmentLines)
    .where(
      and(
        eq(bookingAmendmentLines.amendmentId, amendmentId),
        eq(bookingAmendmentLines.organizationId, organizationId),
        ne(bookingAmendmentLines.action, 'REMOVE'),
      ),
    )
    .orderBy(asc(bookingAmendmentLines.logicalLineId), asc(bookingAmendmentLines.id));

  return rows.map((r) => ({
    id: r.id,
    logicalLineId: r.logicalLineId,
    variantId: r.variantId,
    action: r.action as 'ADD' | 'MODIFY' | 'UNCHANGED',
    originType: r.originType as 'ORIGINAL' | 'AMENDMENT',
    sourceBookingLineId: r.sourceBookingLineId,
    quantity: r.afterQuantity,
    unitPriceAmountMinor: r.afterUnitPriceAmountMinor,
    lineTotalAmountMinor: r.afterLineTotalAmountMinor,
    variantSnapshot: r.variantSnapshot,
  }));
}

async function loadAmendmentAllocations(
  db: DbExecutor,
  amendmentId: string,
  organizationId: string,
): Promise<EffectiveAllocation[]> {
  // Join allocations → amendment_lines pour récupérer logical_line_id.
  const rows = await db
    .select({
      id: bookingAmendmentAllocations.id,
      inventoryItemId: bookingAmendmentAllocations.inventoryItemId,
      action: bookingAmendmentAllocations.action,
      logicalLineId: bookingAmendmentLines.logicalLineId,
      effectiveCustomerStartAt: bookingAmendmentAllocations.effectiveCustomerStartAt,
      effectiveCustomerEndAt: bookingAmendmentAllocations.effectiveCustomerEndAt,
      effectiveBlockedStartAt: bookingAmendmentAllocations.effectiveBlockedStartAt,
      effectiveBlockedEndAt: bookingAmendmentAllocations.effectiveBlockedEndAt,
    })
    .from(bookingAmendmentAllocations)
    .innerJoin(
      bookingAmendmentLines,
      eq(bookingAmendmentAllocations.amendmentLineId, bookingAmendmentLines.id),
    )
    .where(
      and(
        eq(bookingAmendmentAllocations.amendmentId, amendmentId),
        eq(bookingAmendmentAllocations.organizationId, organizationId),
        eq(bookingAmendmentAllocations.status, 'CONVERTED'),
      ),
    )
    .orderBy(
      asc(bookingAmendmentLines.logicalLineId),
      asc(bookingAmendmentAllocations.inventoryItemId),
      asc(bookingAmendmentAllocations.id),
    );

  return rows.map((r) => ({
    id: r.id,
    logicalLineId: r.logicalLineId,
    inventoryItemId: r.inventoryItemId,
    action: r.action as 'RETAIN' | 'ADD' | 'REPLACE',
    effectiveCustomerStartAt: r.effectiveCustomerStartAt,
    effectiveCustomerEndAt: r.effectiveCustomerEndAt,
    effectiveBlockedStartAt: r.effectiveBlockedStartAt,
    effectiveBlockedEndAt: r.effectiveBlockedEndAt,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Loader — projection financière (ADR-023 §4.1, §11.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Charge les six métriques financières en agrégeant deux origines sans produit cartésien.
 *
 * Origine 1 : paiement initial (bookings.paymentId → payments).
 * Origine 2 : amendment_payments de cette booking (amendment_payments.booking_id).
 *
 * Refunds : refunds.payment_id XOR refunds.amendment_payment_id.
 *   - Refunds avec payment_id = bookings.paymentId → origine 1.
 *   - Refunds avec amendment_payment_id IN (amendment_payments de cette booking) → origine 2.
 *
 * Agrégations séparées (SUM sur chaque table) pour éviter toute multiplication.
 */
async function loadFinancials(
  db: DbExecutor,
  organizationId: string,
  bookingId: string,
  paymentId: string,
  contractualTotalAmountMinor: number,
): Promise<EffectiveFinancials> {
  // 1. Paiement initial SUCCEEDED.
  const initialPaymentRows = await db
    .select({ amountMinor: payments.amountMinor })
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.status, 'SUCCEEDED')))
    .limit(1);
  const initialPaymentAmount =
    initialPaymentRows.length > 0 ? initialPaymentRows[0]!.amountMinor : 0;

  // 2. Amendment_payments SUCCEEDED de cette booking.
  const amendmentPaymentSumRows = await db
    .select({ total: sum(amendmentPayments.amountMinor) })
    .from(amendmentPayments)
    .where(
      and(
        eq(amendmentPayments.bookingId, bookingId),
        eq(amendmentPayments.organizationId, organizationId),
        eq(amendmentPayments.status, 'SUCCEEDED'),
      ),
    );
  const amendmentPaymentAmount = normalizeAggregateAmount(
    amendmentPaymentSumRows[0]?.total ?? null,
    'amendment_payments SUCCEEDED',
  );

  const grossCollected = normalizeAggregateAmount(
    initialPaymentAmount + amendmentPaymentAmount,
    'grossCollected',
  );

  // 3. Collecter les IDs des amendment_payments de cette booking (pour les refunds origine 2).
  const amendmentPaymentIdRows = await db
    .select({ id: amendmentPayments.id })
    .from(amendmentPayments)
    .where(
      and(
        eq(amendmentPayments.bookingId, bookingId),
        eq(amendmentPayments.organizationId, organizationId),
      ),
    );
  const amendmentPaymentIds = amendmentPaymentIdRows.map((r) => r.id);

  // 4. Refunds SUCCEEDED — origine 1 (payment_id = bookings.paymentId).
  const refundSucceededInitialRows = await db
    .select({ total: sum(refunds.amountMinor) })
    .from(refunds)
    .where(and(eq(refunds.paymentId, paymentId), eq(refunds.status, 'SUCCEEDED')));
  const refundSucceededInitial = normalizeAggregateAmount(
    refundSucceededInitialRows[0]?.total ?? null,
    'refunds SUCCEEDED (payment initial)',
  );

  // 5. Refunds SUCCEEDED — origine 2 (amendment_payment_id IN ...).
  let refundSucceededAmendment = 0;
  if (amendmentPaymentIds.length > 0) {
    const refundSucceededAmendmentRows = await db
      .select({ total: sum(refunds.amountMinor) })
      .from(refunds)
      .where(
        and(
          inArray(refunds.amendmentPaymentId, amendmentPaymentIds),
          eq(refunds.status, 'SUCCEEDED'),
        ),
      );
    refundSucceededAmendment = normalizeAggregateAmount(
      refundSucceededAmendmentRows[0]?.total ?? null,
      'refunds SUCCEEDED (amendment_payments)',
    );
  }

  const successfulRefunded = normalizeAggregateAmount(
    refundSucceededInitial + refundSucceededAmendment,
    'successfulRefunded',
  );

  // 6. Refunds encore dus (PENDING, SUBMITTED, FAILED_REQUIRES_MANUAL_ACTION) — origine 1.
  const refundOwedInitialRows = await db
    .select({ total: sum(refunds.amountMinor) })
    .from(refunds)
    .where(
      and(
        eq(refunds.paymentId, paymentId),
        inArray(refunds.status, ['PENDING', 'SUBMITTED', 'FAILED_REQUIRES_MANUAL_ACTION']),
      ),
    );
  const refundOwedInitial = normalizeAggregateAmount(
    refundOwedInitialRows[0]?.total ?? null,
    'refunds encore dus (payment initial)',
  );

  // 7. Refunds encore dus — origine 2.
  let refundOwedAmendment = 0;
  if (amendmentPaymentIds.length > 0) {
    const refundOwedAmendmentRows = await db
      .select({ total: sum(refunds.amountMinor) })
      .from(refunds)
      .where(
        and(
          inArray(refunds.amendmentPaymentId, amendmentPaymentIds),
          inArray(refunds.status, ['PENDING', 'SUBMITTED', 'FAILED_REQUIRES_MANUAL_ACTION']),
        ),
      );
    refundOwedAmendment = normalizeAggregateAmount(
      refundOwedAmendmentRows[0]?.total ?? null,
      'refunds encore dus (amendment_payments)',
    );
  }

  const refundStillOwed = normalizeAggregateAmount(
    refundOwedInitial + refundOwedAmendment,
    'refundStillOwed',
  );

  // 8. SETTLED_OFF_PLATFORM — origine 1.
  const refundSettledInitialRows = await db
    .select({ total: sum(refunds.amountMinor) })
    .from(refunds)
    .where(and(eq(refunds.paymentId, paymentId), eq(refunds.status, 'SETTLED_OFF_PLATFORM')));
  const refundSettledInitial = normalizeAggregateAmount(
    refundSettledInitialRows[0]?.total ?? null,
    'refunds SETTLED_OFF_PLATFORM (payment initial)',
  );

  // 9. SETTLED_OFF_PLATFORM — origine 2.
  let refundSettledAmendment = 0;
  if (amendmentPaymentIds.length > 0) {
    const refundSettledAmendmentRows = await db
      .select({ total: sum(refunds.amountMinor) })
      .from(refunds)
      .where(
        and(
          inArray(refunds.amendmentPaymentId, amendmentPaymentIds),
          eq(refunds.status, 'SETTLED_OFF_PLATFORM'),
        ),
      );
    refundSettledAmendment = normalizeAggregateAmount(
      refundSettledAmendmentRows[0]?.total ?? null,
      'refunds SETTLED_OFF_PLATFORM (amendment_payments)',
    );
  }

  const settledOffPlatform = normalizeAggregateAmount(
    refundSettledInitial + refundSettledAmendment,
    'settledOffPlatform',
  );

  // 10. netCollected = grossCollected - successfulRefunded.
  const netCollected = normalizeAggregateAmount(
    grossCollected - successfulRefunded,
    'netCollected',
  );

  // 11. Invariant financier ADR-023 §11.2 :
  //   grossCollected - successfulRefunded - settledOffPlatform - refundStillOwed = contractualTotal
  assertFinancialInvariant(
    grossCollected,
    successfulRefunded,
    settledOffPlatform,
    refundStillOwed,
    contractualTotalAmountMinor,
  );

  return {
    contractualTotalAmountMinor,
    grossCollectedAmountMinor: grossCollected,
    successfulRefundedAmountMinor: successfulRefunded,
    refundStillOwedAmountMinor: refundStillOwed,
    settledOffPlatformAmountMinor: settledOffPlatform,
    netCollectedAmountMinor: netCollected,
    currency: 'EUR',
  };
}
