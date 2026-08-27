/**
 * Clés d'idempotence strictes et déterministes pour chaque notification transactionnelle.
 * Garantit qu'aucun email ne peut être envoyé en double même en cas de rejeu worker ou webhook.
 */

export function buildBookingConfirmedCustomerKey(bookingId: string): string {
  return `booking:${bookingId}:confirmed:customer:v1`;
}

export function buildBookingConfirmedMerchantKey(bookingId: string): string {
  return `booking:${bookingId}:confirmed:merchant:v1`;
}

export function buildBookingCancelledCustomerKey(bookingId: string): string {
  return `booking:${bookingId}:cancelled:customer:v1`;
}

export function buildBookingCancelledMerchantKey(bookingId: string): string {
  return `booking:${bookingId}:cancelled:merchant:v1`;
}

export function buildRefundConfirmedCustomerKey(refundId: string): string {
  return `refund:${refundId}:succeeded:customer:v1`;
}

export function buildRefundActionRequiredMerchantKey(refundId: string): string {
  return `refund:${refundId}:action_required:merchant:v1`;
}

export function buildPickupReminderCustomerKey(bookingId: string): string {
  return `booking:${bookingId}:pickup_reminder:customer:v1`;
}

export function buildReturnReminderCustomerKey(bookingId: string): string {
  return `booking:${bookingId}:return_reminder:customer:v1`;
}
