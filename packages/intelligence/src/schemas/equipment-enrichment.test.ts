import { describe, it, expect } from 'vitest';
import {
  EquipmentEnrichmentInputSchema,
  EquipmentEnrichmentProposalSchema,
  isConfident,
  confident,
  abstain,
  FakeEquipmentEnrichmentProvider,
  DEFAULT_FAKE_BIKE_PROPOSAL,
  ABSTAINING_FAKE_BIKE_PROPOSAL,
} from '../index';

describe('EquipmentEnrichment Schemas & Confidence Policy (ADR-041)', () => {
  const validOrgId = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d';

  describe('EquipmentEnrichmentInputSchema', () => {
    it('valide une entrée conforme avec une image en URL', () => {
      const parsed = EquipmentEnrichmentInputSchema.safeParse({
        organizationId: validOrgId,
        images: [{ url: 'https://images.uttily.local/bike-sample.jpg', mimeType: 'image/jpeg' }],
        locale: 'fr',
      });
      expect(parsed.success).toBe(true);
    });

    it('valide une entrée avec image en base64 et hint de contexte', () => {
      const parsed = EquipmentEnrichmentInputSchema.safeParse({
        organizationId: validOrgId,
        images: [
          {
            base64:
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          },
        ],
        contextHint: 'Facture d’achat : Specialized Turbo Levo 2024',
        locale: 'fr',
      });
      expect(parsed.success).toBe(true);
    });

    it('rejette une entrée sans aucune image', () => {
      const parsed = EquipmentEnrichmentInputSchema.safeParse({
        organizationId: validOrgId,
        images: [],
      });
      expect(parsed.success).toBe(false);
    });

    it('rejette une image sans URL ni base64', () => {
      const parsed = EquipmentEnrichmentInputSchema.safeParse({
        organizationId: validOrgId,
        images: [{ mimeType: 'image/jpeg' }],
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe('EquipmentEnrichmentProposalSchema', () => {
    it('valide la proposition complète par défaut (DEFAULT_FAKE_BIKE_PROPOSAL)', () => {
      const parsed = EquipmentEnrichmentProposalSchema.safeParse(DEFAULT_FAKE_BIKE_PROPOSAL);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.brand.value).toBe('Specialized');
        expect(parsed.data.brand.confidence).toBe(0.99);
        expect(parsed.data.model.value).toBe('Turbo Levo Comp Alloy');
        expect(parsed.data.categorySlug.value).toBe('bike');
        expect(parsed.data.suggestedCondition.value).toBe('GOOD');
        expect(parsed.data.detectedPhotoSlot.value).toBe('HERO_PROFILE');
      }
    });

    it('valide une proposition avec abstention légitime (ABSTAINING_FAKE_BIKE_PROPOSAL)', () => {
      const parsed = EquipmentEnrichmentProposalSchema.safeParse(ABSTAINING_FAKE_BIKE_PROPOSAL);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.brand.value).toBe('Trek');
        expect(parsed.data.frameSize.value).toBeNull();
        expect(parsed.data.frameSize.confidence).toBe(0);
        expect(parsed.data.frameSize.reasoning).toContain('Aucune étiquette');
      }
    });

    it('rejette un score de confiance en dehors de [0, 1]', () => {
      const invalidProposal = {
        ...DEFAULT_FAKE_BIKE_PROPOSAL,
        brand: { value: 'Scott', confidence: 1.5 },
      };
      const parsed = EquipmentEnrichmentProposalSchema.safeParse(invalidProposal);
      expect(parsed.success).toBe(false);
    });

    it('rejette un slot photo non conforme au contrat @uttily/contracts', () => {
      const invalidProposal = {
        ...DEFAULT_FAKE_BIKE_PROPOSAL,
        detectedPhotoSlot: { value: 'UNKNOWN_SLOT', confidence: 0.9 },
      };
      const parsed = EquipmentEnrichmentProposalSchema.safeParse(invalidProposal);
      expect(parsed.success).toBe(false);
    });
  });

  describe('isConfident helper', () => {
    it('identifie un champ confiant au-dessus du seuil', () => {
      const field = confident('Specialized', 0.95);
      expect(isConfident(field, 0.8)).toBe(true);
    });

    it('rejette un champ dont la confiance est inférieure au seuil', () => {
      const field = confident('Specialized', 0.6);
      expect(isConfident(field, 0.8)).toBe(false);
    });

    it('rejette un champ abstenu avec valeur null', () => {
      const field = abstain<string>('Non déterminé');
      expect(isConfident(field)).toBe(false);
    });

    it('gère les valeurs undefined et null avec sécurité', () => {
      expect(isConfident(null)).toBe(false);
      expect(isConfident(undefined)).toBe(false);
    });
  });

  describe('FakeEquipmentEnrichmentProvider', () => {
    it('exécute un enrichissement déterministe avec empreinte d’entrée et métadonnées', async () => {
      const provider = new FakeEquipmentEnrichmentProvider({ latencyMs: 1 });
      const input = {
        organizationId: validOrgId,
        images: [{ url: 'https://images.uttily.local/bike.jpg', mimeType: 'image/jpeg' as const }],
        locale: 'fr' as const,
      };

      const result = await provider.enrichEquipment(input);

      expect(provider.callCount).toBe(1);
      expect(provider.lastInput).toEqual(input);
      expect(result.proposal.brand.value).toBe('Specialized');
      expect(result.metadata.provider).toBe('fake-deterministic');
      expect(result.metadata.promptVersion).toBe('p0-equipment-v1.0');
      expect(result.inputFingerprint).toBeDefined();
      expect(typeof result.inputFingerprint).toBe('string');
    });

    it('propage une erreur lorsque shouldFail est activé', async () => {
      const provider = new FakeEquipmentEnrichmentProvider({ shouldFail: true });
      await expect(
        provider.enrichEquipment({
          organizationId: validOrgId,
          images: [{ url: 'https://images.uttily.local/bike.jpg', mimeType: 'image/jpeg' }],
          locale: 'fr',
        }),
      ).rejects.toThrow('Erreur simulée du fournisseur IA');
    });
  });
});
