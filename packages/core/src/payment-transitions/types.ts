/**
 * @uttily/core — Module Payment Transitions (Phase 7A, ADR-010 §10, §12).
 *
 * Transitions métier source-agnostiques partagées entre les handlers webhook
 * et le moteur de réconciliation. Ces fonctions NE touchent PAS
 * payment_webhook_events — le verrouillage et le marquage du webhook restent
 * la responsabilité de l'appelant (handler webhook ou orchestrateur réconciliation).
 */

import type {
  allocations,
  bookingDrafts,
  inventoryBlocks,
  paymentAttempts,
  payments,
} from '@uttily/database';

/** Lignes métier verrouillées (draft + blocks + allocs + payment + attempt). */
export interface LockedBusinessRows {
  draft: typeof bookingDrafts.$inferSelect;
  blocks: (typeof inventoryBlocks.$inferSelect)[];
  allocs: (typeof allocations.$inferSelect)[];
  payment: typeof payments.$inferSelect;
  attemptRow: typeof paymentAttempts.$inferSelect;
}

/** Lignes paiement verrouillées (payment + attempt uniquement). */
export interface LockedPaymentRows {
  payment: typeof payments.$inferSelect;
  attemptRow: typeof paymentAttempts.$inferSelect;
}
