import { describe, expect, it } from 'vitest';
import {
  buildBookingCancelledCustomerKey,
  buildBookingCancelledMerchantKey,
  buildBookingConfirmedCustomerKey,
  buildBookingConfirmedMerchantKey,
  buildPickupReminderCustomerKey,
  buildRefundActionRequiredMerchantKey,
  buildRefundConfirmedCustomerKey,
  buildReturnReminderCustomerKey,
} from './idempotency-keys';
import {
  renderBookingCancelledCustomer,
  renderBookingCancelledMerchant,
  renderBookingConfirmedCustomer,
  renderBookingConfirmedMerchant,
  renderPickupReminderCustomer,
  renderRefundActionRequiredMerchant,
  renderRefundConfirmedCustomer,
  renderReturnReminderCustomer,
} from './templates';

describe('Notifications — Idempotency Keys', () => {
  const bookingId = '00000000-0000-0000-0000-000000000001';
  const refundId = '00000000-0000-0000-0000-000000000002';

  it('génère des clés d’idempotence déterministes et isolées par template', () => {
    expect(buildBookingConfirmedCustomerKey(bookingId)).toBe(
      `booking:${bookingId}:confirmed:customer:v1`,
    );
    expect(buildBookingConfirmedMerchantKey(bookingId)).toBe(
      `booking:${bookingId}:confirmed:merchant:v1`,
    );
    expect(buildBookingCancelledCustomerKey(bookingId)).toBe(
      `booking:${bookingId}:cancelled:customer:v1`,
    );
    expect(buildBookingCancelledMerchantKey(bookingId)).toBe(
      `booking:${bookingId}:cancelled:merchant:v1`,
    );
    expect(buildPickupReminderCustomerKey(bookingId)).toBe(
      `booking:${bookingId}:pickup_reminder:customer:v1`,
    );
    expect(buildReturnReminderCustomerKey(bookingId)).toBe(
      `booking:${bookingId}:return_reminder:customer:v1`,
    );
    expect(buildRefundConfirmedCustomerKey(refundId)).toBe(
      `refund:${refundId}:succeeded:customer:v1`,
    );
    expect(buildRefundActionRequiredMerchantKey(refundId)).toBe(
      `refund:${refundId}:action_required:merchant:v1`,
    );
  });
});

describe('Notifications — Templates Rendering', () => {
  const baseDate = new Date('2026-09-10T10:00:00Z');
  const endDate = new Date('2026-09-15T18:00:00Z');

  it('rend BOOKING_CONFIRMED_CUSTOMER correctement', () => {
    const rendered = renderBookingConfirmedCustomer({
      bookingId: 'b_1',
      customerName: 'Alice',
      organizationName: 'Lyon Vélos Pro',
      productName: 'Canyon Roadlite M',
      customerStartAt: baseDate,
      customerEndAt: endDate,
      locationName: 'Lyon Centre',
      timeZone: 'Europe/Paris',
      totalAmountMinor: 12000,
    });

    expect(rendered.subject).toContain('Confirmation de votre réservation');
    expect(rendered.subject).toContain('Canyon Roadlite M');
    expect(rendered.html).toContain('Bonjour Alice');
    expect(rendered.html).toContain('Lyon Vélos Pro');
    expect(rendered.html).toContain('120,00');
    expect(rendered.text).toContain('Votre réservation est confirmée ✓');
  });

  it('rend BOOKING_CANCELLED_CUSTOMER en précisant que le remboursement est demandé (pas déjà reçu)', () => {
    const rendered = renderBookingCancelledCustomer({
      bookingId: 'b_1',
      customerName: 'Alice',
      organizationName: 'Lyon Vélos Pro',
      productName: 'Canyon Roadlite M',
      refundAmountMinor: 12000,
      retainedAmountMinor: 0,
    });

    expect(rendered.subject).toContain('Annulation de votre réservation');
    expect(rendered.html).toContain('Remboursement demandé :');
    expect(rendered.html).not.toContain('ont été remboursés');
    expect(rendered.text).toContain('Le virement de remboursement a été transmis');
  });

  it('rend REFUND_CONFIRMED_CUSTOMER lors de la confirmation définitive', () => {
    const rendered = renderRefundConfirmedCustomer({
      refundId: 'r_1',
      customerName: 'Alice',
      productName: 'Canyon Roadlite M',
      organizationName: 'Lyon Vélos Pro',
      amountMinor: 12000,
    });

    expect(rendered.subject).toContain('Votre remboursement de');
    expect(rendered.subject).toContain('120,00');
    expect(rendered.html).toContain('Remboursement confirmé');
    expect(rendered.text).toContain('a été exécuté avec succès');
  });

  it('rend BOOKING_CONFIRMED_MERCHANT et BOOKING_CANCELLED_MERCHANT', () => {
    const confirmedMerchant = renderBookingConfirmedMerchant({
      bookingId: 'b_1',
      organizationName: 'Lyon Vélos Pro',
      customerEmail: 'alice@example.com',
      productName: 'Canyon Roadlite M',
      customerStartAt: baseDate,
      customerEndAt: endDate,
      locationName: 'Lyon Centre',
      timeZone: 'Europe/Paris',
      netRevenueMinor: 10800,
    });
    expect(confirmedMerchant.subject).toContain('Nouvelle réservation confirmée');
    expect(confirmedMerchant.html).toContain('108,00');

    const cancelledMerchant = renderBookingCancelledMerchant({
      bookingId: 'b_1',
      organizationName: 'Lyon Vélos Pro',
      customerEmail: 'alice@example.com',
      productName: 'Canyon Roadlite M',
      actorReason: 'MERCHANT_CANCELLATION',
      retainedAmountMinor: 0,
      finalMerchantRevenueMinor: 0,
    });
    expect(cancelledMerchant.subject).toContain('Annulation de réservation');
    expect(cancelledMerchant.html).toContain('automatiquement débloqué');
  });

  it('rend les rappels de départ et de retour', () => {
    const pickup = renderPickupReminderCustomer({
      bookingId: 'b_1',
      organizationName: 'Lyon Vélos Pro',
      productName: 'Canyon Roadlite M',
      customerStartAt: baseDate,
      locationName: 'Lyon Centre',
      timeZone: 'Europe/Paris',
    });
    expect(pickup.subject).toContain('Rappel : Votre location');
    expect(pickup.html).toContain('Horaire de retrait :');

    const ret = renderReturnReminderCustomer({
      bookingId: 'b_1',
      organizationName: 'Lyon Vélos Pro',
      productName: 'Canyon Roadlite M',
      customerEndAt: endDate,
      locationName: 'Lyon Centre',
      timeZone: 'Europe/Paris',
    });
    expect(ret.subject).toContain('Rappel : Retour de votre équipement');
    expect(ret.html).toContain('Horaire limite de restitution :');
  });

  it('rend REFUND_ACTION_REQUIRED_MERCHANT', () => {
    const action = renderRefundActionRequiredMerchant({
      refundId: 'r_1',
      organizationName: 'Lyon Vélos Pro',
      bookingId: 'b_1',
      amountMinor: 12000,
      failureCode: 'account_closed',
    });
    expect(action.subject).toContain("Action requise : Échec d'un remboursement");
    expect(action.html).toContain('account_closed');
  });
});
