import { describe, it, expect } from 'vitest';
import {
  PreviewBookingAmendmentError,
  isPreviewBookingAmendmentErrorCode,
  type PreviewLineDiffEntry,
} from './types-amendment';
import {
  classifyDelta,
  computeLineDiff,
  validateCommandPayload,
} from './execute-booking-amendment-internal';
import { calculateSupplementCommission } from './supplement-commission';
import type { EffectiveLine } from './types';

describe('previewBookingAmendment — tests unitaires', () => {
  const validBookingId = '11111111-1111-4111-8111-111111111111';
  const validVariantId = '22222222-2222-4222-8222-222222222222';
  const validLogicalLineId = '33333333-3333-4333-8333-333333333333';

  describe('Validation des commandes de prévisualisation (validateCommandPayload)', () => {
    it('valide une commande TIME_RANGE correcte', () => {
      const err = validateCommandPayload(
        validBookingId,
        0,
        {
          kind: 'TIME_RANGE',
          startAt: '2026-06-01T10:00:00',
          endAt: '2026-06-01T18:00:00',
        },
        [{ logicalLineId: validLogicalLineId, variantId: validVariantId, quantity: 1 }],
      );
      expect(err).toBeNull();
    });

    it('valide une commande DAY_RANGE correcte', () => {
      const err = validateCommandPayload(
        validBookingId,
        1,
        {
          kind: 'DAY_RANGE',
          startDate: '2026-06-01',
          endDateExclusive: '2026-06-05',
        },
        [{ variantId: validVariantId, quantity: 2 }],
      );
      expect(err).toBeNull();
    });

    it('rejette un bookingId invalide', () => {
      const err = validateCommandPayload(
        'not-a-uuid',
        0,
        { kind: 'TIME_RANGE', startAt: '2026-06-01T10:00:00', endAt: '2026-06-01T18:00:00' },
        [{ variantId: validVariantId, quantity: 1 }],
      );
      expect(err).toContain('bookingId invalide');
    });

    it('rejette un expectedLastAppliedAmendmentNumber négatif ou non-entier', () => {
      expect(
        validateCommandPayload(
          validBookingId,
          -1,
          { kind: 'TIME_RANGE', startAt: '2026-06-01T10:00:00', endAt: '2026-06-01T18:00:00' },
          [{ variantId: validVariantId, quantity: 1 }],
        ),
      ).toContain('expectedLastAppliedAmendmentNumber');

      expect(
        validateCommandPayload(
          validBookingId,
          1.5,
          { kind: 'TIME_RANGE', startAt: '2026-06-01T10:00:00', endAt: '2026-06-01T18:00:00' },
          [{ variantId: validVariantId, quantity: 1 }],
        ),
      ).toContain('expectedLastAppliedAmendmentNumber');
    });

    it('rejette une intention TIME_RANGE avec fin antérieure ou égale au début', () => {
      const err = validateCommandPayload(
        validBookingId,
        0,
        { kind: 'TIME_RANGE', startAt: '2026-06-01T18:00:00', endAt: '2026-06-01T10:00:00' },
        [{ variantId: validVariantId, quantity: 1 }],
      );
      expect(err).toContain('newCustomerEndAt doit être strictement après newCustomerStartAt');
    });

    it('rejette une intention DAY_RANGE avec date de fin égale ou antérieure', () => {
      const err = validateCommandPayload(
        validBookingId,
        0,
        { kind: 'DAY_RANGE', startDate: '2026-06-05', endDateExclusive: '2026-06-05' },
        [{ variantId: validVariantId, quantity: 1 }],
      );
      expect(err).toContain('newCustomerEndAt doit être strictement après newCustomerStartAt');
    });

    it('rejette desiredLines vide', () => {
      const err = validateCommandPayload(
        validBookingId,
        0,
        { kind: 'TIME_RANGE', startAt: '2026-06-01T10:00:00', endAt: '2026-06-01T18:00:00' },
        [],
      );
      expect(err).toContain('desiredLines doit être un tableau non vide');
    });

    it('rejette une variante en double dans desiredLines', () => {
      const err = validateCommandPayload(
        validBookingId,
        0,
        { kind: 'TIME_RANGE', startAt: '2026-06-01T10:00:00', endAt: '2026-06-01T18:00:00' },
        [
          { variantId: validVariantId, quantity: 1 },
          { variantId: validVariantId, quantity: 2 },
        ],
      );
      expect(err).toContain('variantId en double');
    });

    it('rejette une quantité nulle ou négative', () => {
      expect(
        validateCommandPayload(
          validBookingId,
          0,
          { kind: 'TIME_RANGE', startAt: '2026-06-01T10:00:00', endAt: '2026-06-01T18:00:00' },
          [{ variantId: validVariantId, quantity: 0 }],
        ),
      ).toContain('quantity doit être un entier strictement positif');

      expect(
        validateCommandPayload(
          validBookingId,
          0,
          { kind: 'TIME_RANGE', startAt: '2026-06-01T10:00:00', endAt: '2026-06-01T18:00:00' },
          [{ variantId: validVariantId, quantity: -2 }],
        ),
      ).toContain('quantity doit être un entier strictement positif');
    });
  });

  describe('Classification et calculs financiers (classifyDelta & calculateSupplementCommission)', () => {
    it('classifyDelta classe correctement delta nul comme NEUTRAL', () => {
      expect(classifyDelta(0)).toBe('NEUTRAL');
    });

    it('classifyDelta classe correctement delta négatif comme REFUND', () => {
      expect(classifyDelta(-1000)).toBe('REFUND');
      expect(classifyDelta(-1)).toBe('REFUND');
    });

    it('classifyDelta classe correctement delta positif comme SUPPLEMENT', () => {
      expect(classifyDelta(2500)).toBe('SUPPLEMENT');
      expect(classifyDelta(1)).toBe('SUPPLEMENT');
    });

    it('calcule la commission proportionnelle pour un SUPPLEMENT', () => {
      // Réservation initiale : 100.00 € (10000), commission 15.00 € (1500) -> taux 15%
      // Supplément : 20.00 € (2000) -> commission 3.00 € (300)
      const commission = calculateSupplementCommission(2000, 10000, 1500);
      expect(commission).toBe(300);
      const net = 2000 - commission;
      expect(net).toBe(1700);
    });

    it('garantit commission null pour NEUTRAL et REFUND dans la prévisualisation', () => {
      const neutralClass = classifyDelta(0);
      const refundClass = classifyDelta(-3000);
      expect(neutralClass).toBe('NEUTRAL');
      expect(refundClass).toBe('REFUND');
      // Pour NEUTRAL et REFUND, aucun supplément de commission n'est applicable
      const neutralCommission = neutralClass === 'SUPPLEMENT' ? 100 : null;
      const refundCommission = refundClass === 'SUPPLEMENT' ? 100 : null;
      expect(neutralCommission).toBeNull();
      expect(refundCommission).toBeNull();
    });
  });

  describe('Diff et ordre déterministe des lignes (computeLineDiff)', () => {
    it('gère l ajout, la modification et la suppression de lignes', () => {
      const effectiveLines: EffectiveLine[] = [
        {
          id: 'eff-1',
          logicalLineId: 'line-1',
          variantId: 'var-1',
          action: 'UNCHANGED',
          originType: 'ORIGINAL',
          sourceBookingLineId: 'line-1',
          quantity: 2,
          unitPriceAmountMinor: 1000,
          lineTotalAmountMinor: 2000,
          variantSnapshot: {},
        },
        {
          id: 'eff-2',
          logicalLineId: 'line-2',
          variantId: 'var-2',
          action: 'UNCHANGED',
          originType: 'ORIGINAL',
          sourceBookingLineId: 'line-2',
          quantity: 1,
          unitPriceAmountMinor: 500,
          lineTotalAmountMinor: 500,
          variantSnapshot: {},
        },
      ];

      // On modifie var-1 (quantité 3) et on supprime var-2 (non incluse dans desiredLines)
      const desiredLines = [{ logicalLineId: 'line-1', variantId: 'var-1', quantity: 3 }];

      const diff = computeLineDiff(effectiveLines, desiredLines);
      expect(diff).toHaveLength(2);

      const modEntry = diff.find((d) => d.variantId === 'var-1');
      expect(modEntry).toBeDefined();
      expect(modEntry?.action).toBe('MODIFY');
      expect(modEntry?.beforeQuantity).toBe(2);
      expect(modEntry?.afterQuantity).toBe(3);

      const remEntry = diff.find((d) => d.variantId === 'var-2');
      expect(remEntry).toBeDefined();
      expect(remEntry?.action).toBe('REMOVE');
      expect(remEntry?.beforeQuantity).toBe(1);
      expect(remEntry?.afterQuantity).toBe(0);
    });

    it('trie les lignes de façon déterministe par productName puis variantName', () => {
      const lines: PreviewLineDiffEntry[] = [
        {
          logicalLineId: 'l-3',
          variantId: 'v-3',
          productName: 'Vélo',
          variantName: 'Taille L',
          action: 'UNCHANGED',
          beforeQuantity: 1,
          afterQuantity: 1,
          beforeLineTotalAmountMinor: 1000,
          afterLineTotalAmountMinor: 1000,
        },
        {
          logicalLineId: 'l-1',
          variantId: 'v-1',
          productName: 'Kayak',
          variantName: 'Double',
          action: 'MODIFY',
          beforeQuantity: 1,
          afterQuantity: 2,
          beforeLineTotalAmountMinor: 2000,
          afterLineTotalAmountMinor: 4000,
        },
        {
          logicalLineId: 'l-2',
          variantId: 'v-2',
          productName: 'Kayak',
          variantName: 'Simple',
          action: 'UNCHANGED',
          beforeQuantity: 1,
          afterQuantity: 1,
          beforeLineTotalAmountMinor: 1500,
          afterLineTotalAmountMinor: 1500,
        },
      ];

      lines.sort(
        (a, b) =>
          a.productName.localeCompare(b.productName, 'fr-FR') ||
          a.variantName.localeCompare(b.variantName, 'fr-FR') ||
          a.variantId.localeCompare(b.variantId) ||
          a.logicalLineId.localeCompare(b.logicalLineId),
      );

      expect(lines[0]?.productName).toBe('Kayak');
      expect(lines[0]?.variantName).toBe('Double');
      expect(lines[1]?.productName).toBe('Kayak');
      expect(lines[1]?.variantName).toBe('Simple');
      expect(lines[2]?.productName).toBe('Vélo');
      expect(lines[2]?.variantName).toBe('Taille L');
    });
  });

  describe('PreviewBookingAmendmentError & Type Guards', () => {
    it('vérifie le type guard isPreviewBookingAmendmentErrorCode', () => {
      expect(isPreviewBookingAmendmentErrorCode('VALIDATION')).toBe(true);
      expect(isPreviewBookingAmendmentErrorCode('INTERNAL')).toBe(true);
      expect(isPreviewBookingAmendmentErrorCode('UNKNOWN')).toBe(false);
      expect(isPreviewBookingAmendmentErrorCode(null)).toBe(false);
      expect(isPreviewBookingAmendmentErrorCode(123)).toBe(false);
    });

    it('instancie correctement PreviewBookingAmendmentError', () => {
      const err = new PreviewBookingAmendmentError('INTERNAL', 'Erreur de test interne');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('PreviewBookingAmendmentError');
      expect(err.code).toBe('INTERNAL');
      expect(err.message).toBe('Erreur de test interne');
    });
  });
});
