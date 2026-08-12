/**
 * @uttily/core — Types publics de la projection canonique getEffectiveBooking (G7M-B1).
 *
 * ADR-023 §4.1 et §11.1 : getEffectiveBooking est l'unique autorité de lecture pour
 * l'état effectif d'une réservation, y compris la projection financière complète.
 * Cette phase est strictement read-only.
 */

import type { amendmentType } from '@uttily/database';

/**
 * Ligne effective d'une réservation.
 *
 * - Si aucun amendement APPLIED : issue de booking_lines (originale).
 * - Si un amendement APPLIED : issue de booking_amendment_lines du dernier APPLIED
 *   avec action <> 'REMOVE'.
 */
export interface EffectiveLine {
  readonly id: string;
  readonly logicalLineId: string;
  readonly variantId: string;
  readonly action: 'ADD' | 'MODIFY' | 'UNCHANGED';
  readonly quantity: number;
  readonly unitPriceAmountMinor: number;
  readonly lineTotalAmountMinor: number;
  readonly variantSnapshot: unknown;
}

/**
 * Allocation effective d'une réservation.
 *
 * - Si aucun amendement APPLIED : issue de booking_items (original).
 * - Si un amendement APPLIED : issue de booking_amendment_allocations du dernier
 *   APPLIED avec status = 'CONVERTED'.
 *
 * `logicalLineId` relie l'allocation à sa ligne logique :
 * - projection originale : `booking_items.booking_line_id` (= identité logique originale) ;
 * - projection amendée : `booking_amendment_lines.logical_line_id` (via join
 *   `booking_amendment_allocations.amendment_line_id` → `booking_amendment_lines.id`).
 */
export interface EffectiveAllocation {
  readonly id: string;
  readonly logicalLineId: string;
  readonly inventoryItemId: string;
  readonly action: 'RETAIN' | 'ADD' | 'REPLACE';
  readonly effectiveCustomerStartAt: Date;
  readonly effectiveCustomerEndAt: Date;
  readonly effectiveBlockedStartAt: Date;
  readonly effectiveBlockedEndAt: Date;
}

/**
 * Résumé d'un amendement APPLIED dans l'historique ordonné.
 */
export interface AmendmentSummary {
  readonly id: string;
  readonly amendmentNumber: number;
  readonly type: (typeof amendmentType.enumValues)[number];
  readonly appliedAt: Date;
}

/**
 * Snapshot financier validé (JSONB parsé côté serveur).
 */
export interface FinancialSnapshot {
  readonly totalAmountMinor: number;
  readonly currency: string;
}

/**
 * Projection financière complète (ADR-023 §4.1, §11.1).
 *
 * Six métriques agrégées depuis deux origines (paiement initial + amendment_payments)
 * sans produit cartésien. L'invariant ADR-023 doit être vérifiable :
 *
 *   grossCollected - successfulRefunded - settledOffPlatform - refundStillOwed = contractualTotal
 *
 * Toutes les métriques sont en unités mineures entières sûres, devise EUR.
 */
export interface EffectiveFinancials {
  /** Total contractuel effectif : dernier financial_snapshot_after.totalAmountMinor APPLIED, sinon bookings.totalAmountMinor. */
  readonly contractualTotalAmountMinor: number;
  /** Paiement initial SUCCEEDED + tous les amendment_payments SUCCEEDED de cette booking. */
  readonly grossCollectedAmountMinor: number;
  /** Refunds status = SUCCEEDED, des deux origines (payment_id et amendment_payment_id). */
  readonly successfulRefundedAmountMinor: number;
  /** Refunds status ∈ {PENDING, SUBMITTED, FAILED_REQUIRES_MANUAL_ACTION}, des deux origines. */
  readonly refundStillOwedAmountMinor: number;
  /** Refunds status = SETTLED_OFF_PLATFORM, des deux origines (compté séparément, pas comme encore dû). */
  readonly settledOffPlatformAmountMinor: number;
  /** grossCollectedAmountMinor - successfulRefundedAmountMinor. */
  readonly netCollectedAmountMinor: number;
  /** Devise — toujours EUR (ADR-023 §2.1). */
  readonly currency: 'EUR';
}

/**
 * Projection canonique d'une réservation (ADR-023 §4.1).
 */
export interface EffectiveBooking {
  readonly booking: {
    readonly id: string;
    readonly organizationId: string;
    readonly status: string;
    readonly customerUserId: string;
    readonly locationId: string;
    readonly timezone: string;
  };
  readonly effectiveCustomerStartAt: Date;
  readonly effectiveCustomerEndAt: Date;
  readonly effectiveBlockedStartAt: Date;
  readonly effectiveBlockedEndAt: Date;
  readonly effectiveTotalAmountMinor: number;
  readonly effectiveCurrency: string;
  readonly financials: EffectiveFinancials;
  readonly lines: readonly EffectiveLine[];
  readonly allocations: readonly EffectiveAllocation[];
  readonly lastAppliedAmendmentNumber: number;
  readonly amendments: readonly AmendmentSummary[];
}

/**
 * Résultat fermé et tenant-safe de getEffectiveBooking.
 *
 * NOT_FOUND couvre à la fois une réservation inexistante et une réservation
 * appartenant à une autre organisation (aucune fuite d'information).
 */
export type GetEffectiveBookingResult =
  { readonly kind: 'FOUND'; readonly booking: EffectiveBooking } | { readonly kind: 'NOT_FOUND' };
