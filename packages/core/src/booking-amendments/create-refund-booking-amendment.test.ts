import { describe, expect, it } from 'vitest';
import {
  computeAmendmentFingerprint,
  validateCommand,
  classifyDelta,
} from './execute-booking-amendment-internal';
import {
  isRefundAmendmentErrorCode,
  RefundAmendmentError,
  type NeutralAmendmentCommand,
} from './types-amendment';

describe('createRefundBookingAmendment — Tests unitaires (pure logic)', () => {
  const validBookingId = '11111111-1111-1111-1111-111111111111';
  const validVariantId = '22222222-2222-2222-2222-222222222222';
  const validLogicalLineId = '33333333-3333-3333-3333-333333333333';

  describe('validateCommand', () => {
    it('accepte une commande valide avec TIME_RANGE', () => {
      const err = validateCommand({
        bookingId: validBookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: {
          kind: 'TIME_RANGE',
          startAt: '2026-06-10T09:00:00',
          endAt: '2026-06-12T17:00:00',
        },
        desiredLines: [
          {
            logicalLineId: validLogicalLineId,
            variantId: validVariantId,
            quantity: 1,
          },
        ],
        idempotencyKey: 'refund_key_1',
      });
      expect(err).toBeNull();
    });

    it('accepte une commande valide avec DAY_RANGE', () => {
      const err = validateCommand({
        bookingId: validBookingId,
        expectedLastAppliedAmendmentNumber: 1,
        intent: {
          kind: 'DAY_RANGE',
          startDate: '2026-06-10',
          endDateExclusive: '2026-06-12',
        },
        desiredLines: [
          {
            variantId: validVariantId,
            quantity: 2,
          },
        ],
        idempotencyKey: 'refund_key_2',
      });
      expect(err).toBeNull();
    });

    it('refuse une commande null ou non-objet', () => {
      expect(validateCommand(null as unknown as NeutralAmendmentCommand)).toBe(
        'command doit être un objet.',
      );
    });

    it('refuse un bookingId invalide', () => {
      expect(
        validateCommand({
          bookingId: 'invalid-uuid',
          expectedLastAppliedAmendmentNumber: 0,
          intent: { kind: 'DAY_RANGE', startDate: '2026-06-10', endDateExclusive: '2026-06-12' },
          desiredLines: [{ variantId: validVariantId, quantity: 1 }],
          idempotencyKey: 'key',
        }),
      ).toBe('bookingId invalide (UUID attendu).');
    });

    it('refuse un expectedLastAppliedAmendmentNumber négatif', () => {
      expect(
        validateCommand({
          bookingId: validBookingId,
          expectedLastAppliedAmendmentNumber: -1,
          intent: { kind: 'DAY_RANGE', startDate: '2026-06-10', endDateExclusive: '2026-06-12' },
          desiredLines: [{ variantId: validVariantId, quantity: 1 }],
          idempotencyKey: 'key',
        }),
      ).toBe('expectedLastAppliedAmendmentNumber doit être un entier sûr >= 0.');
    });

    it('refuse des doublons de variantId dans desiredLines', () => {
      expect(
        validateCommand({
          bookingId: validBookingId,
          expectedLastAppliedAmendmentNumber: 0,
          intent: { kind: 'DAY_RANGE', startDate: '2026-06-10', endDateExclusive: '2026-06-12' },
          desiredLines: [
            { variantId: validVariantId, quantity: 1 },
            { variantId: validVariantId, quantity: 2 },
          ],
          idempotencyKey: 'key',
        }),
      ).toContain('variantId en double');
    });

    it('refuse une quantité <= 0', () => {
      expect(
        validateCommand({
          bookingId: validBookingId,
          expectedLastAppliedAmendmentNumber: 0,
          intent: { kind: 'DAY_RANGE', startDate: '2026-06-10', endDateExclusive: '2026-06-12' },
          desiredLines: [{ variantId: validVariantId, quantity: 0 }],
          idempotencyKey: 'key',
        }),
      ).toContain('quantity doit être un entier strictement positif');
    });
  });

  describe('classifyDelta', () => {
    it('classifie delta < 0 comme REFUND', () => {
      expect(classifyDelta(-3000)).toBe('REFUND');
    });

    it('classifie delta = 0 comme NEUTRAL', () => {
      expect(classifyDelta(0)).toBe('NEUTRAL');
    });

    it('classifie delta > 0 comme SUPPLEMENT', () => {
      expect(classifyDelta(1500)).toBe('SUPPLEMENT');
    });
  });

  describe('computeAmendmentFingerprint', () => {
    it('génère une empreinte canonique SHA-256 déterministe indépendante de l’ordre des lignes', () => {
      const variantA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const variantB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

      const cmd1 = {
        bookingId: validBookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: {
          kind: 'DAY_RANGE' as const,
          startDate: '2026-06-10',
          endDateExclusive: '2026-06-12',
        },
        desiredLines: [
          { variantId: variantA, quantity: 1 },
          { variantId: variantB, quantity: 2 },
        ],
        idempotencyKey: 'k',
      };

      const cmd2 = {
        bookingId: validBookingId,
        expectedLastAppliedAmendmentNumber: 0,
        intent: {
          kind: 'DAY_RANGE' as const,
          startDate: '2026-06-10',
          endDateExclusive: '2026-06-12',
        },
        desiredLines: [
          { variantId: variantB, quantity: 2 },
          { variantId: variantA, quantity: 1 },
        ],
        idempotencyKey: 'k',
      };

      const fp1 = computeAmendmentFingerprint(cmd1, 'amendment-refund-v1');
      const fp2 = computeAmendmentFingerprint(cmd2, 'amendment-refund-v1');

      expect(fp1).toBe(fp2);
      expect(fp1).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('RefundAmendmentError & guards', () => {
    it('instancie correctement RefundAmendmentError avec son code fermé', () => {
      const err = new RefundAmendmentError('INTERNAL', 'Erreur interne test.');
      expect(err.name).toBe('RefundAmendmentError');
      expect(err.code).toBe('INTERNAL');
      expect(err.message).toBe('Erreur interne test.');
    });

    it('valide le type guard isRefundAmendmentErrorCode', () => {
      expect(isRefundAmendmentErrorCode('INTERNAL')).toBe(true);
      expect(isRefundAmendmentErrorCode('VALIDATION')).toBe(true);
      expect(isRefundAmendmentErrorCode('UNKNOWN')).toBe(false);
    });
  });
});
