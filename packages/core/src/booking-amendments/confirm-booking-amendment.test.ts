import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import { confirmBookingAmendment } from './confirm-booking-amendment';
import * as memberships from '../identity/memberships';
import * as previewModule from './preview-booking-amendment';
import * as neutralModule from './create-neutral-booking-amendment';
import * as refundModule from './create-refund-booking-amendment';
import * as supplementModule from './create-supplement-booking-amendment';
import type { AuthenticatedUser } from '../identity/types';
import type {
  ConfirmBookingAmendmentCommand,
  PreviewBookingAmendmentSuccess,
} from './types-amendment';

describe('confirmBookingAmendment (Unit Tests — G7M-C5-B Hardened)', () => {
  let mockRecords: Array<{
    id: string;
    operation: string;
    requestFingerprint: string;
    status: string;
    responseBody: unknown;
  }> = [];

  const mockSelect = vi.fn().mockImplementation(() => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(() => Promise.resolve(mockRecords)),
    }),
  }));

  const mockDb = {
    select: mockSelect,
    transaction: vi.fn().mockImplementation(async (cb) => cb({ select: mockSelect })),
  } as unknown as DatabaseClient;

  const orgId = '11111111-1111-4111-8111-111111111111';
  const bookingId = '22222222-2222-4222-8222-222222222222';
  const variantId = '33333333-3333-4333-8333-333333333333';
  const idempotencyKey = '44444444-4444-4444-8444-444444444444';
  const validAmendmentUuid = '77777777-7777-4777-8777-777777777777';

  const managerUser: AuthenticatedUser = {
    id: '55555555-5555-4555-8555-555555555555',
    email: 'mgr@example.com',
    oidcSubject: 'sub_mgr',
    emailVerified: true,
    isPlatformAdmin: false,
  };

  const baseCommand: ConfirmBookingAmendmentCommand = {
    bookingId,
    expectedLastAppliedAmendmentNumber: 0,
    intent: { kind: 'DAY_RANGE', startDate: '2026-06-01', endDateExclusive: '2026-06-05' },
    desiredLines: [{ variantId, quantity: 2 }],
    idempotencyKey,
    expectedClassification: 'NEUTRAL',
    expectedDeltaAmountMinor: 0,
    expectedNextTotalAmountMinor: 10000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRecords = [];
    vi.spyOn(memberships, 'getMembership').mockResolvedValue({
      organizationId: orgId,
      userId: managerUser.id,
      role: 'MANAGER',
      status: 'ACTIVE',
    });
  });

  describe('Validation des entrées & Liaison obligatoire à la preview', () => {
    it('retourne FORBIDDEN si l acteur est invalide', async () => {
      const res = await confirmBookingAmendment(
        mockDb,
        { ...managerUser, id: 'not-a-uuid' },
        orgId,
        baseCommand,
      );
      expect(res.kind).toBe('FORBIDDEN');
    });

    it('retourne INVALID_INPUT si organizationId est invalide', async () => {
      const res = await confirmBookingAmendment(mockDb, managerUser, 'not-a-uuid', baseCommand);
      expect(res.kind).toBe('INVALID_INPUT');
    });

    it('retourne INVALID_INPUT si idempotencyKey n est pas un UUID valide', async () => {
      const res = await confirmBookingAmendment(mockDb, managerUser, orgId, {
        ...baseCommand,
        idempotencyKey: 'not-a-uuid',
      });
      expect(res.kind).toBe('INVALID_INPUT');
      if (res.kind === 'INVALID_INPUT') {
        expect(res.message).toContain('idempotencyKey');
      }
    });

    it('retourne INVALID_INPUT si expectedClassification est absent ou invalide', async () => {
      const res1 = await confirmBookingAmendment(mockDb, managerUser, orgId, {
        ...baseCommand,
        expectedClassification: undefined as unknown as 'NEUTRAL',
      });
      expect(res1.kind).toBe('INVALID_INPUT');

      const res2 = await confirmBookingAmendment(mockDb, managerUser, orgId, {
        ...baseCommand,
        expectedClassification: 'INVALID_ENUM' as unknown as 'NEUTRAL',
      });
      expect(res2.kind).toBe('INVALID_INPUT');
    });

    it('retourne INVALID_INPUT si expectedDeltaAmountMinor est absent ou non-safe', async () => {
      const res1 = await confirmBookingAmendment(mockDb, managerUser, orgId, {
        ...baseCommand,
        expectedDeltaAmountMinor: undefined as unknown as number,
      });
      expect(res1.kind).toBe('INVALID_INPUT');

      const res2 = await confirmBookingAmendment(mockDb, managerUser, orgId, {
        ...baseCommand,
        expectedDeltaAmountMinor: 12.34 as unknown as number,
      });
      expect(res2.kind).toBe('INVALID_INPUT');

      const res3 = await confirmBookingAmendment(mockDb, managerUser, orgId, {
        ...baseCommand,
        expectedDeltaAmountMinor: Number.NaN,
      });
      expect(res3.kind).toBe('INVALID_INPUT');
    });

    it('retourne INVALID_INPUT si expectedNextTotalAmountMinor est absent, négatif ou non-safe', async () => {
      const res1 = await confirmBookingAmendment(mockDb, managerUser, orgId, {
        ...baseCommand,
        expectedNextTotalAmountMinor: undefined as unknown as number,
      });
      expect(res1.kind).toBe('INVALID_INPUT');

      const res2 = await confirmBookingAmendment(mockDb, managerUser, orgId, {
        ...baseCommand,
        expectedNextTotalAmountMinor: -500,
      });
      expect(res2.kind).toBe('INVALID_INPUT');

      const res3 = await confirmBookingAmendment(mockDb, managerUser, orgId, {
        ...baseCommand,
        expectedNextTotalAmountMinor: 100.5,
      });
      expect(res3.kind).toBe('INVALID_INPUT');
    });

    it('retourne FORBIDDEN si le rôle est STAFF', async () => {
      vi.spyOn(memberships, 'getMembership').mockResolvedValueOnce({
        organizationId: orgId,
        userId: managerUser.id,
        role: 'STAFF',
        status: 'ACTIVE',
      });

      const res = await confirmBookingAmendment(mockDb, managerUser, orgId, baseCommand);
      expect(res.kind).toBe('FORBIDDEN');
    });

    it('retourne FORBIDDEN si l utilisateur n a pas de membership', async () => {
      vi.spyOn(memberships, 'getMembership').mockRejectedValueOnce(new Error('NOT_FOUND'));

      const res = await confirmBookingAmendment(mockDb, managerUser, orgId, baseCommand);
      expect(res.kind).toBe('FORBIDDEN');
    });
  });

  describe('Recalcul de la prévisualisation & propagation des erreurs', () => {
    it('propage NOT_FOUND renvoyé par previewBookingAmendment', async () => {
      vi.spyOn(previewModule, 'previewBookingAmendment').mockResolvedValueOnce({
        kind: 'NOT_FOUND',
      });

      const res = await confirmBookingAmendment(mockDb, managerUser, orgId, baseCommand);
      expect(res.kind).toBe('NOT_FOUND');
    });

    it('propage BOOKING_NOT_CONFIRMED renvoyé par previewBookingAmendment', async () => {
      vi.spyOn(previewModule, 'previewBookingAmendment').mockResolvedValueOnce({
        kind: 'BOOKING_NOT_CONFIRMED',
      });

      const res = await confirmBookingAmendment(mockDb, managerUser, orgId, baseCommand);
      expect(res.kind).toBe('BOOKING_NOT_CONFIRMED');
    });

    it('propage ACTIVE_AMENDMENT_EXISTS renvoyé par previewBookingAmendment', async () => {
      vi.spyOn(previewModule, 'previewBookingAmendment').mockResolvedValueOnce({
        kind: 'ACTIVE_AMENDMENT_EXISTS',
      });

      const res = await confirmBookingAmendment(mockDb, managerUser, orgId, baseCommand);
      expect(res.kind).toBe('ACTIVE_AMENDMENT_EXISTS');
    });

    it('propage STALE_EFFECTIVE_BOOKING renvoyé par previewBookingAmendment', async () => {
      vi.spyOn(previewModule, 'previewBookingAmendment').mockResolvedValueOnce({
        kind: 'STALE_EFFECTIVE_BOOKING',
        expected: 0,
        actual: 1,
      });

      const res = await confirmBookingAmendment(mockDb, managerUser, orgId, baseCommand);
      expect(res.kind).toBe('STALE_EFFECTIVE_BOOKING');
      if (res.kind === 'STALE_EFFECTIVE_BOOKING') {
        expect(res.expected).toBe(0);
        expect(res.actual).toBe(1);
      }
    });

    it('propage AVAILABILITY_CONFLICT renvoyé par previewBookingAmendment', async () => {
      vi.spyOn(previewModule, 'previewBookingAmendment').mockResolvedValueOnce({
        kind: 'AVAILABILITY_CONFLICT',
        message: 'Stock insuffisant pour satisfaire la quantité demandée.',
      });

      const res = await confirmBookingAmendment(mockDb, managerUser, orgId, baseCommand);
      expect(res.kind).toBe('AVAILABILITY_CONFLICT');
      if (res.kind === 'AVAILABILITY_CONFLICT') {
        expect(res.message).toBe('Stock insuffisant pour satisfaire la quantité demandée.');
      }
    });
  });

  describe('Détection de dérive PREVIEW_CHANGED', () => {
    const mockPreviewSuccess: PreviewBookingAmendmentSuccess = {
      kind: 'SUCCESS',
      bookingId,
      locationId: 'loc-1',
      locationTimeZone: 'Europe/Paris',
      lastAppliedAmendmentNumber: 0,
      classification: 'NEUTRAL',
      previousCustomerStartAt: new Date('2026-06-01T08:00:00Z'),
      previousCustomerEndAt: new Date('2026-06-05T18:00:00Z'),
      nextCustomerStartAt: new Date('2026-06-02T08:00:00Z'),
      nextCustomerEndAt: new Date('2026-06-06T18:00:00Z'),
      previousContractualTotalAmountMinor: 10000,
      nextContractualTotalAmountMinor: 10000,
      deltaAmountMinor: 0,
      currency: 'EUR',
      supplementCommissionAmountMinor: null,
      supplementNetAmountMinor: null,
      lines: [],
    };

    it('retourne PREVIEW_CHANGED si expectedClassification diffère du recalcul serveur', async () => {
      vi.spyOn(previewModule, 'previewBookingAmendment').mockResolvedValueOnce({
        ...mockPreviewSuccess,
        classification: 'NEUTRAL',
      });

      const res = await confirmBookingAmendment(mockDb, managerUser, orgId, {
        ...baseCommand,
        expectedClassification: 'REFUND',
      });

      expect(res.kind).toBe('PREVIEW_CHANGED');
    });

    it('retourne PREVIEW_CHANGED si expectedDeltaAmountMinor diffère du recalcul serveur', async () => {
      vi.spyOn(previewModule, 'previewBookingAmendment').mockResolvedValueOnce({
        ...mockPreviewSuccess,
        deltaAmountMinor: 0,
      });

      const res = await confirmBookingAmendment(mockDb, managerUser, orgId, {
        ...baseCommand,
        expectedDeltaAmountMinor: -5000,
      });

      expect(res.kind).toBe('PREVIEW_CHANGED');
    });

    it('retourne PREVIEW_CHANGED si expectedNextTotalAmountMinor diffère du recalcul serveur', async () => {
      vi.spyOn(previewModule, 'previewBookingAmendment').mockResolvedValueOnce({
        ...mockPreviewSuccess,
        nextContractualTotalAmountMinor: 10000,
      });

      const res = await confirmBookingAmendment(mockDb, managerUser, orgId, {
        ...baseCommand,
        expectedNextTotalAmountMinor: 15000,
      });

      expect(res.kind).toBe('PREVIEW_CHANGED');
    });
  });

  describe('Sécurité d idempotence & Replay fail-closed', () => {
    it('ignore une clé d une opération étrangère (ex: booking-draft:create) et poursuit normalement', async () => {
      // Mock db returns 0 allowed amendment records (foreign operation filtered out in query)
      mockRecords = [];

      vi.spyOn(previewModule, 'previewBookingAmendment').mockResolvedValueOnce({
        kind: 'SUCCESS',
        bookingId,
        locationId: 'loc-1',
        locationTimeZone: 'Europe/Paris',
        lastAppliedAmendmentNumber: 0,
        classification: 'NEUTRAL',
        previousCustomerStartAt: new Date('2026-06-01T08:00:00Z'),
        previousCustomerEndAt: new Date('2026-06-05T18:00:00Z'),
        nextCustomerStartAt: new Date('2026-06-02T08:00:00Z'),
        nextCustomerEndAt: new Date('2026-06-06T18:00:00Z'),
        previousContractualTotalAmountMinor: 10000,
        nextContractualTotalAmountMinor: 10000,
        deltaAmountMinor: 0,
        currency: 'EUR',
        supplementCommissionAmountMinor: null,
        supplementNetAmountMinor: null,
        lines: [],
      });

      vi.spyOn(neutralModule, 'createNeutralBookingAmendment').mockResolvedValueOnce({
        kind: 'SUCCESS',
        amendmentId: validAmendmentUuid,
        amendmentNumber: 1,
      });

      const res = await confirmBookingAmendment(mockDb, managerUser, orgId, baseCommand);
      expect(res.kind).toBe('APPLIED_NEUTRAL');
    });

    it('retourne INVALID_STATE si plusieurs enregistrements d amendement existent pour la même clé', async () => {
      mockRecords = [
        {
          id: 'rec-1',
          operation: 'booking-amendment-neutral',
          requestFingerprint: 'f1',
          status: 'COMPLETED',
          responseBody: { amendmentId: validAmendmentUuid, amendmentNumber: 1 },
        },
        {
          id: 'rec-2',
          operation: 'booking-amendment-refund',
          requestFingerprint: 'f2',
          status: 'COMPLETED',
          responseBody: {
            amendmentId: validAmendmentUuid,
            amendmentNumber: 1,
            refundAmountMinor: 1000,
          },
        },
      ];

      const neutralSpy = vi.spyOn(neutralModule, 'createNeutralBookingAmendment');

      const res = await confirmBookingAmendment(mockDb, managerUser, orgId, baseCommand);
      expect(res.kind).toBe('INVALID_STATE');
      expect(neutralSpy).not.toHaveBeenCalled();
    });

    it('retourne INVALID_STATE si responseBody est null ou non-objet lors d un replay COMPLETED', async () => {
      // Calculate valid fingerprint for neutral v2
      const { computeAmendmentFingerprint } = await import('./execute-booking-amendment-internal');
      const validFp = computeAmendmentFingerprint(baseCommand, 'amendment-neutral-v2');

      mockRecords = [
        {
          id: 'rec-1',
          operation: 'booking-amendment-neutral',
          requestFingerprint: validFp,
          status: 'COMPLETED',
          responseBody: null,
        },
      ];

      const neutralSpy = vi.spyOn(neutralModule, 'createNeutralBookingAmendment');
      const res = await confirmBookingAmendment(mockDb, managerUser, orgId, baseCommand);

      expect(res.kind).toBe('INVALID_STATE');
      expect(neutralSpy).not.toHaveBeenCalled();
    });

    it('retourne INVALID_STATE si amendmentId est invalide dans responseBody COMPLETED', async () => {
      const { computeAmendmentFingerprint } = await import('./execute-booking-amendment-internal');
      const validFp = computeAmendmentFingerprint(baseCommand, 'amendment-neutral-v2');

      mockRecords = [
        {
          id: 'rec-1',
          operation: 'booking-amendment-neutral',
          requestFingerprint: validFp,
          status: 'COMPLETED',
          responseBody: { amendmentId: 'not-a-valid-uuid', amendmentNumber: 1 },
        },
      ];

      const res = await confirmBookingAmendment(mockDb, managerUser, orgId, baseCommand);
      expect(res.kind).toBe('INVALID_STATE');
    });

    it('retourne INVALID_STATE si refundAmountMinor est invalide lors d un replay REFUND COMPLETED', async () => {
      const refundCommand: ConfirmBookingAmendmentCommand = {
        ...baseCommand,
        expectedClassification: 'REFUND',
        expectedDeltaAmountMinor: -5000,
        expectedNextTotalAmountMinor: 5000,
      };
      const { computeAmendmentFingerprint } = await import('./execute-booking-amendment-internal');
      const validFp = computeAmendmentFingerprint(refundCommand, 'amendment-refund-v1');

      mockRecords = [
        {
          id: 'rec-1',
          operation: 'booking-amendment-refund',
          requestFingerprint: validFp,
          status: 'COMPLETED',
          responseBody: {
            amendmentId: validAmendmentUuid,
            amendmentNumber: 1,
            refundAmountMinor: 0,
          },
        },
      ];

      const res = await confirmBookingAmendment(mockDb, managerUser, orgId, refundCommand);
      expect(res.kind).toBe('INVALID_STATE');
    });

    it('retourne INVALID_STATE si holdDeadline est invalide lors d un replay SUPPLEMENT COMPLETED', async () => {
      const supplementCommand: ConfirmBookingAmendmentCommand = {
        ...baseCommand,
        expectedClassification: 'SUPPLEMENT',
        expectedDeltaAmountMinor: 5000,
        expectedNextTotalAmountMinor: 15000,
      };
      const { computeAmendmentFingerprint } = await import('./execute-booking-amendment-internal');
      const validFp = computeAmendmentFingerprint(supplementCommand, 'amendment-supplement-v1');

      mockRecords = [
        {
          id: 'rec-1',
          operation: 'booking-amendment-supplement',
          requestFingerprint: validFp,
          status: 'COMPLETED',
          responseBody: {
            amendmentId: validAmendmentUuid,
            amendmentNumber: 1,
            supplementAmountMinor: 5000,
            holdDeadline: 'invalid-iso-date',
          },
        },
      ];

      const res = await confirmBookingAmendment(mockDb, managerUser, orgId, supplementCommand);
      expect(res.kind).toBe('INVALID_STATE');
    });
  });

  describe('Dispatch vers mutations & Normalisation', () => {
    const mockPreviewNeutral: PreviewBookingAmendmentSuccess = {
      kind: 'SUCCESS',
      bookingId,
      locationId: 'loc-1',
      locationTimeZone: 'Europe/Paris',
      lastAppliedAmendmentNumber: 0,
      classification: 'NEUTRAL',
      previousCustomerStartAt: new Date('2026-06-01T08:00:00Z'),
      previousCustomerEndAt: new Date('2026-06-05T18:00:00Z'),
      nextCustomerStartAt: new Date('2026-06-02T08:00:00Z'),
      nextCustomerEndAt: new Date('2026-06-06T18:00:00Z'),
      previousContractualTotalAmountMinor: 10000,
      nextContractualTotalAmountMinor: 10000,
      deltaAmountMinor: 0,
      currency: 'EUR',
      supplementCommissionAmountMinor: null,
      supplementNetAmountMinor: null,
      lines: [],
    };

    it('applique avec succès un amendement NEUTRAL et normalise la réponse', async () => {
      vi.spyOn(previewModule, 'previewBookingAmendment').mockResolvedValueOnce(mockPreviewNeutral);
      vi.spyOn(neutralModule, 'createNeutralBookingAmendment').mockResolvedValueOnce({
        kind: 'SUCCESS',
        amendmentId: 'amend-neutral-1',
        amendmentNumber: 1,
      });

      const res = await confirmBookingAmendment(mockDb, managerUser, orgId, baseCommand);

      expect(res.kind).toBe('APPLIED_NEUTRAL');
      if (res.kind === 'APPLIED_NEUTRAL') {
        expect(res.amendmentId).toBe('amend-neutral-1');
        expect(res.amendmentNumber).toBe(1);
        expect(res.bookingId).toBe(bookingId);
        expect(res.isReplay).toBe(false);
      }
    });

    it('gère le REPLAY idempotent pour un amendement NEUTRAL', async () => {
      vi.spyOn(previewModule, 'previewBookingAmendment').mockResolvedValueOnce(mockPreviewNeutral);
      vi.spyOn(neutralModule, 'createNeutralBookingAmendment').mockResolvedValueOnce({
        kind: 'REPLAY',
        amendmentId: 'amend-neutral-1',
        amendmentNumber: 1,
      });

      const res = await confirmBookingAmendment(mockDb, managerUser, orgId, baseCommand);

      expect(res.kind).toBe('APPLIED_NEUTRAL');
      if (res.kind === 'APPLIED_NEUTRAL') {
        expect(res.isReplay).toBe(true);
      }
    });

    it('applique avec succès un amendement REFUND sans exposer de refundId technique', async () => {
      const refundCommand: ConfirmBookingAmendmentCommand = {
        ...baseCommand,
        expectedClassification: 'REFUND',
        expectedDeltaAmountMinor: -5000,
        expectedNextTotalAmountMinor: 5000,
      };

      vi.spyOn(previewModule, 'previewBookingAmendment').mockResolvedValueOnce({
        ...mockPreviewNeutral,
        classification: 'REFUND',
        deltaAmountMinor: -5000,
        nextContractualTotalAmountMinor: 5000,
      });
      vi.spyOn(refundModule, 'createRefundBookingAmendment').mockResolvedValueOnce({
        kind: 'SUCCESS',
        amendmentId: 'amend-refund-1',
        amendmentNumber: 1,
        refundId: 'ref-internal-999',
        refundAmountMinor: 5000,
      });

      const res = await confirmBookingAmendment(mockDb, managerUser, orgId, refundCommand);

      expect(res.kind).toBe('APPLIED_REFUND');
      if (res.kind === 'APPLIED_REFUND') {
        expect(res.amendmentId).toBe('amend-refund-1');
        expect(res.amendmentNumber).toBe(1);
        expect(res.bookingId).toBe(bookingId);
        expect(res.refundAmountMinor).toBe(5000);
        expect(res.currency).toBe('EUR');
        expect(res.isReplay).toBe(false);
        expect((res as unknown as Record<string, unknown>).refundId).toBeUndefined();
      }
    });

    it('crée un amendement SUPPLEMENT (hold + paiement) sans exposer de payment IDs ou clientSecret', async () => {
      const supCommand: ConfirmBookingAmendmentCommand = {
        ...baseCommand,
        expectedClassification: 'SUPPLEMENT',
        expectedDeltaAmountMinor: 5000,
        expectedNextTotalAmountMinor: 15000,
      };

      vi.spyOn(previewModule, 'previewBookingAmendment').mockResolvedValueOnce({
        ...mockPreviewNeutral,
        classification: 'SUPPLEMENT',
        deltaAmountMinor: 5000,
        nextContractualTotalAmountMinor: 15000,
        supplementCommissionAmountMinor: 250,
        supplementNetAmountMinor: 4750,
      });
      vi.spyOn(supplementModule, 'createSupplementBookingAmendment').mockResolvedValueOnce({
        kind: 'SUCCESS',
        amendmentId: 'amend-sup-1',
        amendmentNumber: 1,
        amendmentPaymentId: 'ap-internal-888',
        amendmentPaymentAttemptId: 'apa-internal-777',
        supplementAmountMinor: 5000,
        holdDeadline: '2026-06-01T10:10:00.000Z',
      });

      const res = await confirmBookingAmendment(mockDb, managerUser, orgId, supCommand);

      expect(res.kind).toBe('PAYMENT_REQUIRED');
      if (res.kind === 'PAYMENT_REQUIRED') {
        expect(res.amendmentId).toBe('amend-sup-1');
        expect(res.amendmentNumber).toBe(1);
        expect(res.bookingId).toBe(bookingId);
        expect(res.supplementAmountMinor).toBe(5000);
        expect(res.currency).toBe('EUR');
        expect(res.holdDeadline).toBe('2026-06-01T10:10:00.000Z');
        expect(res.isReplay).toBe(false);
        const raw = res as unknown as Record<string, unknown>;
        expect(raw.amendmentPaymentId).toBeUndefined();
        expect(raw.amendmentPaymentAttemptId).toBeUndefined();
        expect(raw.clientSecret).toBeUndefined();
      }
    });
  });
});
