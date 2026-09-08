import { describe, expect, it } from 'vitest';
import { DEMO_PHOTO_COACH_ORG_ID } from '@/lib/photo-coach-constants';
import { analyzePhotoQualityAction, confirmEquipmentFeaturesAction } from './photo-coach';
import { uploadProductPhotoAction } from './product-photos';

describe('Photo Coach Demo Flow (unauthenticated / public playground)', () => {
  it('permet l’analyse de photo IA sans exiger d’appartenance organisationnelle', async () => {
    // Dummy JPEG buffer
    const dummyBuffer = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x60, 0x00, 0x60, 0x00, 0x00, 0xff, 0xd9]);
    const file = new File([dummyBuffer], 'test-bike.jpg', { type: 'image/jpeg' });

    const formData = new FormData();
    formData.append('file', file);
    formData.append('expectedSlot', 'HERO_PROFILE');
    formData.append('categorySlug', 'bike');

    const result = await analyzePhotoQualityAction(
      DEMO_PHOTO_COACH_ORG_ID,
      { ok: false, code: 'UNKNOWN', message: '' },
      formData,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeDefined();
      expect(result.data.matchedSlot).toBe('HERO_PROFILE');
      expect(result.data.quality).toBeDefined();
    }
  });

  it('permet la confirmation des caractéristiques détectées en mode démo sans écriture DB', async () => {
    const result = await confirmEquipmentFeaturesAction({
      organizationId: DEMO_PHOTO_COACH_ORG_ID,
      productId: 'b5555acf-3f6a-4474-aa18-4d107993abbb',
      features: { isElectric: true, hasLuggageRack: true },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.updatedVariantsCount).toBe(1);
    }
  });

  it('permet l’enregistrement d’une photo de démonstration sans rejet d’authentification', async () => {
    const dummyBuffer = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const file = new File([dummyBuffer], 'bike-hero.jpg', { type: 'image/jpeg' });

    const formData = new FormData();
    formData.append('productId', 'b5555acf-3f6a-4474-aa18-4d107993abbb');
    formData.append('photoId', '11111111-2222-3333-4444-555555555555');
    formData.append('slotType', 'HERO_PROFILE');
    formData.append('file', file);

    const result = await uploadProductPhotoAction(
      DEMO_PHOTO_COACH_ORG_ID,
      { ok: false, code: 'UNKNOWN', message: '' },
      formData,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe('11111111-2222-3333-4444-555555555555');
      expect(result.data.slotType).toBe('HERO_PROFILE');
      expect(result.data.fileState).toBe('AVAILABLE');
    }
  });

  it('rejette formellement un objet non conforme (ex: lunettes au lieu d’un vélo) avec verdict REJECTED', async () => {
    // Si OPENROUTER_API_KEY est configurée, tester le rejet IA de l'image de lunettes
    if (!process.env.OPENROUTER_API_KEY) return;

    const fs = await import('node:fs');
    const path = await import('node:path');
    const imagePath = path.resolve('/Users/hamza/.gemini/antigravity-ide/brain/80e21069-5cbf-4e6d-8f16-3d8d7691689d/.user_uploaded/media_1788819792515.jpg');
    if (!fs.existsSync(imagePath)) return;

    const buffer = fs.readFileSync(imagePath);
    const file = new File([buffer], 'sunglasses.jpg', { type: 'image/jpeg' });

    const formData = new FormData();
    formData.append('file', file);
    formData.append('expectedSlot', 'HERO_PROFILE');
    formData.append('categorySlug', 'bike');

    const result = await analyzePhotoQualityAction(
      DEMO_PHOTO_COACH_ORG_ID,
      { ok: false, code: 'UNKNOWN', message: '' },
      formData,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.verdict).toBe('REJECTED');
      expect(result.data.slotConformity).toBe(false);
      expect(result.data.detectedFeatures.isElectric).toBe(false);
      expect(result.data.issuesFr.length).toBeGreaterThan(0);
      expect(result.data.issuesFr.some((issue) => issue.toLowerCase().includes('lunette') || issue.toLowerCase().includes('vélo'))).toBe(true);
    }
  });
});
