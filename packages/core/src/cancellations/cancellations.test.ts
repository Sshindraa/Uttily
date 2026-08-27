import { describe, it, expect } from 'vitest';
import type { DbExecutor } from '@uttily/database';
import { previewBookingCancellation } from './preview-booking-cancellation';
import { cancelConfirmedBooking } from './cancel-confirmed-booking';

function createMockDb(bookingOverrides: Record<string, unknown> = {}): DbExecutor {
  const defaultBooking = {
    bookingId: '00000000-0000-0000-0000-000000000002',
    organizationId: '00000000-0000-0000-0000-000000000001',
    status: 'CONFIRMED',
    customerStartAt: new Date('2026-09-10T10:00:00Z'),
    customerEndAt: new Date('2026-09-15T18:00:00Z'),
    confirmedAt: new Date('2026-09-01T10:00:00Z'),
    totalAmountMinor: 10000, // 100,00 €
    commissionAmountMinor: 1000, // 10,00 € (10%)
    cancellationPolicySnapshot: { policy_code: 'FLEXIBLE', policy_version: '1' },
    paymentId: '00000000-0000-0000-0000-000000000003',
    paymentAmountMinor: 10000,
    paymentCommissionMinor: 1000,
    locationTimeZone: 'Europe/Paris',
    ...bookingOverrides,
  };

  const fakeQuery = {
    from: () => fakeQuery,
    innerJoin: () => fakeQuery,
    leftJoin: () => fakeQuery,
    where: () => Promise.resolve([defaultBooking]),
  };

  return {
    select: () => fakeQuery,
  } as unknown as DbExecutor;
}

describe('Chantier 12 — Domaine Annulations & Remboursements V2', () => {
  it('rejette les identifiants invalides lors du preview', async () => {
    const fakeDb = {} as unknown as DbExecutor;
    await expect(
      previewBookingCancellation(fakeDb, 'not-a-uuid', '00000000-0000-0000-0000-000000000001'),
    ).rejects.toThrow('organizationId');

    await expect(
      previewBookingCancellation(fakeDb, '00000000-0000-0000-0000-000000000001', 'not-a-uuid'),
    ).rejects.toThrow('bookingId');
  });

  it('rejette les identifiants invalides ou idempotencyKey vide lors de l’annulation', async () => {
    const fakeClient = {} as unknown as import('@uttily/database').DatabaseClient;
    await expect(
      cancelConfirmedBooking(fakeClient, {
        organizationId: 'not-a-uuid',
        bookingId: '00000000-0000-0000-0000-000000000001',
        actorUserId: '00000000-0000-0000-0000-000000000002',
        actorReason: 'MERCHANT_CANCELLATION',
        idempotencyKey: 'idem_1',
      }),
    ).rejects.toThrow('organizationId');

    await expect(
      cancelConfirmedBooking(fakeClient, {
        organizationId: '00000000-0000-0000-0000-000000000001',
        bookingId: '00000000-0000-0000-0000-000000000002',
        actorUserId: '00000000-0000-0000-0000-000000000003',
        actorReason: 'MERCHANT_CANCELLATION',
        idempotencyKey: '',
      }),
    ).rejects.toThrow('idempotencyKey');
  });

  it('rembourse à 100% sans frais lors d’une annulation loueur (MERCHANT_CANCELLATION)', async () => {
    const mockDb = createMockDb();
    const result = await previewBookingCancellation(
      mockDb,
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      {
        actorReason: 'MERCHANT_CANCELLATION',
        now: new Date('2026-09-10T09:00:00Z'), // 1h avant
      },
    );

    expect(result.allowed).toBe(true);
    expect(result.refundAmountMinor).toBe(10000);
    expect(result.retainedAmountMinor).toBe(0);
    expect(result.commissionRefundedMinor).toBe(1000);
    expect(result.finalCommissionMinor).toBe(0);
    expect(result.finalMerchantRevenueMinor).toBe(0);
    expect(result.explanationCode).toBe('FULL_REFUND_MERCHANT');
  });

  it('applique la politique FLEXIBLE correctement (100% si >= 24h, 0% si < 24h)', async () => {
    const mockDb = createMockDb({
      cancellationPolicySnapshot: { policy_code: 'FLEXIBLE', policy_version: '1' },
      confirmedAt: new Date('2026-09-01T10:00:00Z'),
      customerStartAt: new Date('2026-09-10T10:00:00Z'),
    });

    // 1. Plus de 24h avant départ (ex: 48h)
    const preview48h = await previewBookingCancellation(
      mockDb,
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      {
        actorReason: 'CUSTOMER_CANCELLATION',
        now: new Date('2026-09-08T10:00:00Z'),
      },
    );
    expect(preview48h.refundAmountMinor).toBe(10000);
    expect(preview48h.retainedAmountMinor).toBe(0);
    expect(preview48h.explanationCode).toBe('FLEXIBLE_GE_24H');

    // 2. Moins de 24h avant départ (ex: 12h)
    const preview12h = await previewBookingCancellation(
      mockDb,
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      {
        actorReason: 'CUSTOMER_CANCELLATION',
        now: new Date('2026-09-09T22:00:00Z'),
      },
    );
    expect(preview12h.refundAmountMinor).toBe(0);
    expect(preview12h.retainedAmountMinor).toBe(10000);
    expect(preview12h.finalCommissionMinor).toBe(1000);
    expect(preview12h.finalMerchantRevenueMinor).toBe(9000);
    expect(preview12h.explanationCode).toBe('FLEXIBLE_LT_24H');
  });

  it('applique la politique MODERATE correctement (100% >= 5j, 50% entre 24h et 5j, 0% < 24h)', async () => {
    const mockDb = createMockDb({
      cancellationPolicySnapshot: { policy_code: 'MODERATE', policy_version: '1' },
      confirmedAt: new Date('2026-09-01T10:00:00Z'),
      customerStartAt: new Date('2026-09-10T10:00:00Z'),
    });

    // 1. Annulation à 3 jours (50% de remboursement, commission proratisée)
    const preview3d = await previewBookingCancellation(
      mockDb,
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      {
        actorReason: 'CUSTOMER_CANCELLATION',
        now: new Date('2026-09-07T10:00:00Z'),
      },
    );
    expect(preview3d.refundAmountMinor).toBe(5000);
    expect(preview3d.retainedAmountMinor).toBe(5000);
    expect(preview3d.commissionRefundedMinor).toBe(500);
    expect(preview3d.finalCommissionMinor).toBe(500);
    expect(preview3d.finalMerchantRevenueMinor).toBe(4500);
    expect(preview3d.explanationCode).toBe('MODERATE_24H_5D');
  });

  it('applique la politique FIRME correctement (100% >= 14j, 50% entre 7j et 14j, 0% < 7j)', async () => {
    const mockDb = createMockDb({
      cancellationPolicySnapshot: { policy_code: 'FIRM', policy_version: '1' },
      confirmedAt: new Date('2026-08-01T10:00:00Z'),
      customerStartAt: new Date('2026-09-10T10:00:00Z'),
    });

    // Annulation à 5 jours (< 7j)
    const preview5d = await previewBookingCancellation(
      mockDb,
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      {
        actorReason: 'CUSTOMER_CANCELLATION',
        now: new Date('2026-09-05T10:00:00Z'),
      },
    );
    expect(preview5d.refundAmountMinor).toBe(0);
    expect(preview5d.retainedAmountMinor).toBe(10000);
    expect(preview5d.explanationCode).toBe('FIRM_LT_7D');
  });

  it('applique la fenêtre de grâce de 24h après confirmation (réservation >= 7j à l’avance)', async () => {
    const mockDb = createMockDb({
      cancellationPolicySnapshot: { policy_code: 'FIRM', policy_version: '1' },
      confirmedAt: new Date('2026-09-01T10:00:00Z'),
      customerStartAt: new Date('2026-09-10T10:00:00Z'), // 9 jours après confirmation
    });

    // Annulation 5 heures après confirmation
    const previewGrace = await previewBookingCancellation(
      mockDb,
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      {
        actorReason: 'CUSTOMER_CANCELLATION',
        now: new Date('2026-09-01T15:00:00Z'),
      },
    );
    expect(previewGrace.refundAmountMinor).toBe(10000);
    expect(previewGrace.retainedAmountMinor).toBe(0);
    expect(previewGrace.explanationCode).toBe('GRACE_WINDOW_24H');
  });

  it('refuse le preview si le statut de la réservation n’est pas éligible (ex: ACTIVE ou CANCELLED)', async () => {
    const mockDb = createMockDb({ status: 'ACTIVE' });
    const result = await previewBookingCancellation(
      mockDb,
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
    );
    expect(result.allowed).toBe(false);
    expect(result.explanationCode).toBe('STATUS_NOT_ELIGIBLE');
    expect(result.inventoryWillBeReleased).toBe(false);
  });
});
