/**
 * @uttily/contracts — DTO, validation et contrats d'événements.
 *
 * Vide au Lot 0. Les DTO et schémas d'événements d'outbox seront
 * introduits à partir du Lot 1.
 *
 * Le Lot 2B introduit le contrat ActionResult (union typée ActionErrorCode)
 * utilisé par les Server Actions Next.js.
 */
export * from './action-result';
export * from './enums';
export * from './booking-confirmed-event';
export * from './booking-amended-event';
export * from './booking-amendment-requested-event';
export * from './booking-cancelled-event';
export * from './refund-requested-event';
export * from './photo-slots';
