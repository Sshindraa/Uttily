import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import { previewBookingAmendmentAction } from './booking-amendments';
import * as amendmentAuth from '@/lib/amendment-auth';
import * as core from '@uttily/core';

vi.mock('@/lib/amendment-auth', () => ({
  requireAmendmentManagerOf: vi.fn(),
}));

vi.mock('@uttily/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@uttily/core')>();
  return {
    ...actual,
    previewBookingAmendment: vi.fn(),
  };
});

describe('previewBookingAmendmentAction', () => {
  const orgId = '11111111-1111-4111-8111-111111111111';
  const bookingId = '22222222-2222-4222-8222-222222222222';
  const variantId = '33333333-3333-4333-8333-333333333333';
  const logicalLineId = '44444444-4444-4444-8444-444444444444';
  const mockDb = {} as unknown as DatabaseClient;
  const mockUser = {
    id: '55555555-5555-4555-8555-555555555555',
    email: 'mgr@example.com',
    oidcSubject: 'sub_555',
    emailVerified: true,
    isPlatformAdmin: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejette une organisation invalide', async () => {
    const res = await previewBookingAmendmentAction('invalid-uuid', {
      bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: { kind: 'DAY_RANGE', startDate: '2026-06-01', endDateExclusive: '2026-06-02' },
      lines: [{ variantId, quantity: 1 }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('VALIDATION');
      expect(res.message).toBe('Organisation invalide.');
    }
  });

  it('rejette un bookingId invalide', async () => {
    const res = await previewBookingAmendmentAction(orgId, {
      bookingId: 'invalid-booking-uuid',
      expectedLastAppliedAmendmentNumber: 0,
      intent: { kind: 'DAY_RANGE', startDate: '2026-06-01', endDateExclusive: '2026-06-02' },
      lines: [{ variantId, quantity: 1 }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('VALIDATION');
      expect(res.message).toBe('Réservation invalide.');
    }
  });

  it('valide une intention TIME_RANGE correcte', async () => {
    vi.spyOn(amendmentAuth, 'requireAmendmentManagerOf').mockResolvedValueOnce({
      user: mockUser,
      db: mockDb,
      organizationId: orgId,
    });
    vi.spyOn(core, 'previewBookingAmendment').mockResolvedValueOnce({
      kind: 'SUCCESS',
      bookingId,
      locationId: '66666666-6666-4666-8666-666666666666',
      locationTimeZone: 'Europe/Paris',
      lastAppliedAmendmentNumber: 0,
      classification: 'NEUTRAL',
      previousCustomerStartAt: new Date('2026-06-01T10:00:00Z'),
      previousCustomerEndAt: new Date('2026-06-01T18:00:00Z'),
      nextCustomerStartAt: new Date('2026-06-01T10:00:00Z'),
      nextCustomerEndAt: new Date('2026-06-01T18:00:00Z'),
      previousContractualTotalAmountMinor: 5000,
      nextContractualTotalAmountMinor: 5000,
      deltaAmountMinor: 0,
      currency: 'EUR',
      supplementCommissionAmountMinor: null,
      supplementNetAmountMinor: null,
      lines: [],
    });

    const res = await previewBookingAmendmentAction(orgId, {
      bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: { kind: 'TIME_RANGE', startAt: '2026-06-01T10:00', endAt: '2026-06-01T18:00' },
      lines: [{ variantId, quantity: 1 }],
    });
    expect(res.ok).toBe(true);
  });

  it('rejette une intention TIME_RANGE avec fin antérieure au début', async () => {
    const res = await previewBookingAmendmentAction(orgId, {
      bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: { kind: 'TIME_RANGE', startAt: '2026-06-01T18:00', endAt: '2026-06-01T10:00' },
      lines: [{ variantId, quantity: 1 }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('VALIDATION');
      expect(res.message).toContain('postérieures au début');
    }
  });

  it('rejette si toutes les quantités sont nulles', async () => {
    const res = await previewBookingAmendmentAction(orgId, {
      bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: { kind: 'DAY_RANGE', startDate: '2026-06-01', endDateExclusive: '2026-06-02' },
      lines: [{ variantId, quantity: 0 }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('VALIDATION');
      expect(res.message).toContain('au moins un article avec une quantité positive');
    }
  });

  it('retourne UNAUTHENTICATED si l utilisateur n est pas connecté', async () => {
    vi.spyOn(amendmentAuth, 'requireAmendmentManagerOf').mockRejectedValueOnce(
      new Error('UNAUTHENTICATED'),
    );

    const res = await previewBookingAmendmentAction(orgId, {
      bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: { kind: 'DAY_RANGE', startDate: '2026-06-01', endDateExclusive: '2026-06-02' },
      lines: [{ variantId, quantity: 1 }],
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('UNAUTHENTICATED');
    }
  });

  it('retourne FORBIDDEN si l utilisateur n est pas manager', async () => {
    vi.spyOn(amendmentAuth, 'requireAmendmentManagerOf').mockRejectedValueOnce(
      new Error('FORBIDDEN'),
    );

    const res = await previewBookingAmendmentAction(orgId, {
      bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: { kind: 'DAY_RANGE', startDate: '2026-06-01', endDateExclusive: '2026-06-02' },
      lines: [{ variantId, quantity: 1 }],
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('FORBIDDEN');
    }
  });

  it('mappe AVAILABILITY_CONFLICT en CONFLICT_BLOCK avec message utilisateur fixe et sûr', async () => {
    vi.spyOn(amendmentAuth, 'requireAmendmentManagerOf').mockResolvedValueOnce({
      user: mockUser,
      db: mockDb,
      organizationId: orgId,
    });
    vi.spyOn(core, 'previewBookingAmendment').mockResolvedValueOnce({
      kind: 'AVAILABILITY_CONFLICT',
      message: 'Stock insuffisant pour satisfaire la quantité demandée.',
    });

    const res = await previewBookingAmendmentAction(orgId, {
      bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: { kind: 'DAY_RANGE', startDate: '2026-06-01', endDateExclusive: '2026-06-02' },
      lines: [{ variantId, quantity: 2 }],
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('CONFLICT_BLOCK');
      expect(res.message).toBe(
        'Certains articles ne sont plus disponibles pour les dates demandées.',
      );
    }
  });

  it('ne fait jamais fuiter d UUID interne lors d un AVAILABILITY_CONFLICT Core contenant des identifiants', async () => {
    const internalUuid = '99999999-9999-4999-8999-999999999999';
    vi.spyOn(amendmentAuth, 'requireAmendmentManagerOf').mockResolvedValueOnce({
      user: mockUser,
      db: mockDb,
      organizationId: orgId,
    });
    vi.spyOn(core, 'previewBookingAmendment').mockResolvedValueOnce({
      kind: 'AVAILABILITY_CONFLICT',
      message: `Stock insuffisant pour la variante ${internalUuid}: demandé 5, disponible 2.`,
    });

    const res = await previewBookingAmendmentAction(orgId, {
      bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: { kind: 'DAY_RANGE', startDate: '2026-06-01', endDateExclusive: '2026-06-02' },
      lines: [{ variantId, quantity: 5 }],
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('CONFLICT_BLOCK');
      expect(res.message).not.toContain(internalUuid);
      expect(res.message).toBe(
        'Certains articles ne sont plus disponibles pour les dates demandées.',
      );
    }
  });

  it('ne fait jamais fuiter d UUID interne lors d un INVALID_INPUT Core contenant des identifiants', async () => {
    const internalUuid = '88888888-8888-4888-8888-888888888888';
    vi.spyOn(amendmentAuth, 'requireAmendmentManagerOf').mockResolvedValueOnce({
      user: mockUser,
      db: mockDb,
      organizationId: orgId,
    });
    vi.spyOn(core, 'previewBookingAmendment').mockResolvedValueOnce({
      kind: 'INVALID_INPUT',
      message: `Libellés introuvables pour la variante ${internalUuid}.`,
    });

    const res = await previewBookingAmendmentAction(orgId, {
      bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: { kind: 'DAY_RANGE', startDate: '2026-06-01', endDateExclusive: '2026-06-02' },
      lines: [{ variantId, quantity: 1 }],
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('VALIDATION');
      expect(res.message).not.toContain(internalUuid);
      expect(res.message).toBe('Les changements demandés ne peuvent pas être prévisualisés.');
    }
  });

  it('mappe avec succès une prévisualisation SUPPLEMENT avec commission et net', async () => {
    vi.spyOn(amendmentAuth, 'requireAmendmentManagerOf').mockResolvedValueOnce({
      user: mockUser,
      db: mockDb,
      organizationId: orgId,
    });

    const mockSuccess: core.PreviewBookingAmendmentSuccess = {
      kind: 'SUCCESS',
      bookingId,
      locationId: '66666666-6666-4666-8666-666666666666',
      locationTimeZone: 'Europe/Paris',
      lastAppliedAmendmentNumber: 0,
      classification: 'SUPPLEMENT',
      previousCustomerStartAt: new Date('2026-06-01T08:00:00Z'),
      previousCustomerEndAt: new Date('2026-06-02T18:00:00Z'),
      nextCustomerStartAt: new Date('2026-06-01T08:00:00Z'),
      nextCustomerEndAt: new Date('2026-06-04T18:00:00Z'),
      previousContractualTotalAmountMinor: 5000,
      nextContractualTotalAmountMinor: 10000,
      deltaAmountMinor: 5000,
      currency: 'EUR',
      supplementCommissionAmountMinor: 750,
      supplementNetAmountMinor: 4250,
      lines: [
        {
          logicalLineId,
          variantId,
          productName: 'Kayak',
          variantName: 'Standard',
          action: 'MODIFY',
          beforeQuantity: 1,
          afterQuantity: 1,
          beforeLineTotalAmountMinor: 5000,
          afterLineTotalAmountMinor: 10000,
        },
      ],
    };

    vi.spyOn(core, 'previewBookingAmendment').mockResolvedValueOnce(mockSuccess);

    const res = await previewBookingAmendmentAction(orgId, {
      bookingId,
      expectedLastAppliedAmendmentNumber: 0,
      intent: { kind: 'DAY_RANGE', startDate: '2026-06-01', endDateExclusive: '2026-06-04' },
      lines: [{ logicalLineId, variantId, quantity: 1 }],
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.classification).toBe('SUPPLEMENT');
      expect(res.data.deltaAmountMinor).toBe(5000);
      expect(res.data.supplementCommissionAmountMinor).toBe(750);
      expect(res.data.supplementNetAmountMinor).toBe(4250);
    }
  });
});
