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
  renderOrganizationInvitation,
  renderPickupReminderCustomer,
  renderRefundActionRequiredMerchant,
  renderRefundConfirmedCustomer,
  renderReturnReminderCustomer,
} from './templates';
import { renderNotificationRecord } from './load-notification-data';
import type { DbExecutor, NotificationRecord } from '@uttily/database';

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
      `booking:${bookingId}:pickup_reminder:customer:r0:v1`,
    );
    expect(buildPickupReminderCustomerKey(bookingId, 2)).toBe(
      `booking:${bookingId}:pickup_reminder:customer:r2:v1`,
    );
    expect(buildReturnReminderCustomerKey(bookingId)).toBe(
      `booking:${bookingId}:return_reminder:customer:r0:v1`,
    );
    expect(buildReturnReminderCustomerKey(bookingId, 1)).toBe(
      `booking:${bookingId}:return_reminder:customer:r1:v1`,
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

  it('rend BOOKING_CANCELLED_MERCHANT avec le motif', () => {
    const rendered = renderBookingCancelledMerchant({
      bookingId: 'b_1',
      organizationName: 'Lyon Vélos Pro',
      productName: 'Canyon Roadlite M',
      customerEmail: 'alice@example.com',
      actorReason: 'ANNULATION_CLIENT',
      retainedAmountMinor: 2000,
      finalMerchantRevenueMinor: 1800,
    });

    expect(rendered.subject).toContain('Annulation de réservation — Canyon Roadlite M');
    expect(rendered.html).toContain('ANNULATION_CLIENT');
    expect(rendered.html).toContain('18,00');
    expect(rendered.text).toContain('alice@example.com');
  });

  it('rend REFUND_CONFIRMED_CUSTOMER', () => {
    const rendered = renderRefundConfirmedCustomer({
      refundId: 'r_1',
      customerName: 'Alice',
      organizationName: 'Lyon Vélos Pro',
      productName: 'Canyon Roadlite M',
      amountMinor: 12000,
    });

    expect(rendered.subject).toContain('Votre remboursement de 120,00 € a été confirmé');
    expect(rendered.html).toContain('120,00');
    expect(rendered.text).toContain('Lyon Vélos Pro');
  });

  it('rend PICKUP_REMINDER_CUSTOMER avec instructions et téléphone', () => {
    const pickup = renderPickupReminderCustomer({
      bookingId: 'b_1',
      customerName: 'Alice',
      organizationName: 'Lyon Vélos Pro',
      productName: 'Canyon Roadlite M',
      customerStartAt: baseDate,
      locationName: 'Lyon Centre',
      locationAddress: '10 rue de la République',
      locationPhone: '+33 4 78 00 00 00',
      timeZone: 'Europe/Paris',
      pickupInstructions: 'Présentez-vous au comptoir avec votre pièce d’identité.',
    });
    expect(pickup.subject).toContain('Rappel : Votre location Canyon Roadlite M débute bientôt');
    expect(pickup.html).toContain('Consignes de retrait :');
    expect(pickup.html).toContain('Présentez-vous au comptoir avec votre pièce d’identité.');
    expect(pickup.html).toContain('+33 4 78 00 00 00');
  });

  it('rend RETURN_REMINDER_CUSTOMER avec instructions et téléphone', () => {
    const ret = renderReturnReminderCustomer({
      bookingId: 'b_1',
      customerName: 'Alice',
      organizationName: 'Lyon Vélos Pro',
      productName: 'Canyon Roadlite M',
      customerEndAt: endDate,
      locationName: 'Lyon Centre',
      locationAddress: '10 rue de la République',
      locationPhone: '+33 4 78 00 00 00',
      timeZone: 'Europe/Paris',
      returnInstructions: 'Déposez le vélo dans le sas sécurisé avec le code 4589.',
    });
    expect(ret.subject).toContain('Rappel : Retour de votre équipement Canyon Roadlite M');
    expect(ret.html).toContain('Horaire limite de restitution :');
    expect(ret.html).toContain('Déposez le vélo dans le sas sécurisé avec le code 4589.');
    expect(ret.html).toContain('+33 4 78 00 00 00');
  });

  it('rend ORGANIZATION_INVITATION avec rôle traduit, validité 7 jours et bouton', () => {
    const invitation = renderOrganizationInvitation({
      organizationName: 'Lyon Vélos Pro',
      roleName: 'Administrateur',
      acceptUrl: 'https://uttily.com/invitations?token=tok_123',
    });
    expect(invitation.subject).toContain('Invitation à rejoindre Lyon Vélos Pro');
    expect(invitation.html).toContain('Administrateur');
    expect(invitation.html).toContain('Rejoindre l’équipe');
    expect(invitation.html).toContain('7 jours');
    expect(invitation.text).toContain('https://uttily.com/invitations?token=tok_123');
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

  describe('renderNotificationRecord — ORGANIZATION_INVITATION (Chantier 15.2)', () => {
    it('reconstruit le token signé sans secret brut dans les métadonnées', async () => {
      process.env.PUBLIC_APP_URL = 'http://localhost:3000';
      process.env.INVITATION_SECRET = 'notification-test-secret-at-least-32-chars-long!';
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const fakeDb = {
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: () => [
                  {
                    id: 'inv-uuid-1',
                    organizationId: 'org-uuid-1',
                    email: 'invitee@example.com',
                    role: 'ADMIN',
                    expiresAt,
                    status: 'PENDING',
                    orgLegalName: 'Lyon Vélos SAS',
                    orgDisplayName: 'Lyon Vélos Pro',
                  },
                ],
              }),
            }),
          }),
        }),
      } as unknown as DbExecutor;

      const notif: NotificationRecord = {
        id: 'notif-1',
        organizationId: 'org-uuid-1',
        template: 'ORGANIZATION_INVITATION',
        channel: 'EMAIL',
        recipient: 'invitee@example.com',
        status: 'PENDING',
        idempotencyKey: 'invitation:inv-uuid-1',
        scheduledFor: new Date(),
        metadata: {
          invitationId: 'inv-uuid-1',
          organizationName: 'Lyon Vélos Pro',
          roleName: 'Administrateur',
        },
        bookingId: null,
        refundId: null,
        attemptCount: 0,
        providerFirstAttemptStartedAt: null,
        nextAttemptAt: null,
        failedAt: null,
        sentAt: null,
        leaseToken: null,
        leaseUntil: null,
        failureCode: null,
        providerMessageId: null,
        requiresManualReview: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const rendered = await renderNotificationRecord(fakeDb, notif);
      expect(rendered.subject).toContain('Invitation à rejoindre Lyon Vélos Pro');
      expect(rendered.html).toContain('Administrateur');
      expect(rendered.html).toContain('token=inv-uuid-1.');
      expect(rendered.text).toContain('/invitations?token=inv-uuid-1.');
    });
  });
});
