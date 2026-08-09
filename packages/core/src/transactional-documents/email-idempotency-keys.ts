/**
 * @uttily/core — Clés d'idempotence pour les emails transactionnels (G5E, ADR-013 §11).
 *
 * Deux clés distinctes, stables, sans PII :
 * - provider_idempotency_key : envoyée au fournisseur d'email pour la déduplication
 *   côté fournisseur. Formule : email_provider_{outboxEventId}_SEND_EMAIL_v1
 * - idempotency_key : clé d'idempotence DB pour notification_deliveries.
 *   Formule : email_delivery_{outboxEventId}_v1
 *
 * Les deux clés sont dérivées de l'outboxEventId uniquement — aucun bookingId,
 * email, nom ou adresse n'est inclus.
 */

/** Template key fermé pour les emails de confirmation de réservation. */
export const BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY = 'booking_confirmed_customer';

/**
 * Clé d'idempotence fournisseur pour un effet SEND_EMAIL.
 * Dérivée de l'outboxEventId (stable, sans PII).
 * Formule : email_provider_{outboxEventId}_SEND_EMAIL_v1
 */
export function emailProviderIdempotencyKey(outboxEventId: string): string {
  return `email_provider_${outboxEventId}_SEND_EMAIL_v1`;
}

/**
 * Clé d'idempotence DB pour notification_deliveries.
 * Distincte de la clé fournisseur, stable, sans PII.
 * Formule : email_delivery_{outboxEventId}_v1
 */
export function emailDeliveryIdempotencyKey(outboxEventId: string): string {
  return `email_delivery_${outboxEventId}_v1`;
}
