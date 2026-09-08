import { describe, it, expect } from 'vitest';
import {
  PhotoQualityAssessmentSchema,
  PhotoCoachVerdictSchema,
  DetectedEquipmentFeaturesSchema,
  QualityMetricsSchema,
} from './photo-coach-schema';
import { FakePhotoCoachAnalyzer } from '../fakes/fake-photo-coach';

describe('PhotoCoachSchema (G8B-3 / Phase 2)', () => {
  it('valide un rapport complet conforme', () => {
    const assessment = {
      verdict: 'CONFORMANT',
      matchedSlot: 'HERO_PROFILE',
      slotConformity: true,
      quality: {
        sharpnessScore: 90,
        exposureScore: 85,
        framingScore: 95,
        backgroundNeutralityScore: 80,
      },
      detectedFeatures: {
        isElectric: true,
        hasLuggageRack: true,
        hasTrailerHitch: false,
        hasChildSeatCompatibleMount: true,
        drivetrainType: 'DERAILLEUR',
        brakeType: 'HYDRAULIC_DISC',
        frameType: 'STEP_THROUGH',
        visibleSizeLabel: 'L',
        confidence: 0.95,
      },
      issuesFr: [],
      issuesEn: [],
      suggestionsFr: ['Photo conforme aux standards professionnels.'],
      suggestionsEn: ['Photo meets professional standards.'],
    };

    const parsed = PhotoQualityAssessmentSchema.parse(assessment);
    expect(parsed.verdict).toBe('CONFORMANT');
    expect(parsed.quality.sharpnessScore).toBe(90);
    expect(parsed.detectedFeatures.isElectric).toBe(true);
    expect(parsed.detectedFeatures.hasLuggageRack).toBe(true);
    expect(parsed.detectedFeatures.visibleSizeLabel).toBe('L');
  });

  it('rejette les scores hors intervalle [0, 100]', () => {
    expect(() => {
      QualityMetricsSchema.parse({
        sharpnessScore: 120, // invalide
        exposureScore: 80,
        framingScore: 90,
        backgroundNeutralityScore: 70,
      });
    }).toThrow();
  });

  it('valide les verdicts autorisés (CONFORMANT, WARNING, REJECTED)', () => {
    expect(PhotoCoachVerdictSchema.parse('CONFORMANT')).toBe('CONFORMANT');
    expect(PhotoCoachVerdictSchema.parse('WARNING')).toBe('WARNING');
    expect(PhotoCoachVerdictSchema.parse('REJECTED')).toBe('REJECTED');
    expect(() => PhotoCoachVerdictSchema.parse('EXCELLENT')).toThrow();
  });

  it('valide les caractéristiques physiques détectées avec DetectedEquipmentFeaturesSchema', () => {
    const features = DetectedEquipmentFeaturesSchema.parse({
      isElectric: true,
      hasLuggageRack: false,
      hasTrailerHitch: false,
      hasChildSeatCompatibleMount: false,
      drivetrainType: 'DERAILLEUR',
      brakeType: 'HYDRAULIC_DISC',
      frameType: 'DIAMOND',
      confidence: 0.88,
    });
    expect(features.isElectric).toBe(true);
    expect(features.drivetrainType).toBe('DERAILLEUR');
  });
});

describe('FakePhotoCoachAnalyzer', () => {
  const analyzer = new FakePhotoCoachAnalyzer();

  it('génère une évaluation conforme par défaut', async () => {
    const result = await analyzer.analyzePhoto({
      imageBase64OrDataUrl: 'data:image/jpeg;base64,mock_good_profile',
      expectedSlot: 'HERO_PROFILE',
      categorySlug: 'bike',
    });

    expect(result.verdict).toBe('CONFORMANT');
    expect(result.slotConformity).toBe(true);
    expect(result.quality.sharpnessScore).toBeGreaterThan(80);
    expect(result.detectedFeatures.hasLuggageRack).toBe(true);
    expect(result.detectedFeatures.isElectric).toBe(true);
  });

  it('détecte et rejette une photo floue avec conseil de reprise', async () => {
    const result = await analyzer.analyzePhoto({
      imageBase64OrDataUrl: 'data:image/jpeg;base64,mock_blurry_data',
      expectedSlot: 'HERO_PROFILE',
    });

    expect(result.verdict).toBe('REJECTED');
    expect(result.slotConformity).toBe(false);
    expect(result.quality.sharpnessScore).toBeLessThan(40);
    expect(result.suggestionsFr[0]).toContain('Stabilisez');
  });

  it('détecte et rejette un cadrage tronqué avec conseil de distance', async () => {
    const result = await analyzer.analyzePhoto({
      imageBase64OrDataUrl: 'data:image/jpeg;base64,mock_cropped_wheels',
      expectedSlot: 'HERO_PROFILE',
    });

    expect(result.verdict).toBe('REJECTED');
    expect(result.quality.framingScore).toBeLessThan(40);
    expect(result.suggestionsFr[0]).toContain('Reculez');
  });

  it('émet un avertissement si le vélo est photographié côté non-transmission', async () => {
    const result = await analyzer.analyzePhoto({
      imageBase64OrDataUrl: 'data:image/jpeg;base64,mock_wrong_side',
      expectedSlot: 'HERO_PROFILE',
    });

    expect(result.verdict).toBe('WARNING');
    expect(result.issuesFr[0]).toContain('côté opposé à la transmission');
    expect(result.suggestionsFr[0]).toContain('Tournez le vélo');
  });
});
