import type { PhotoSlotType } from '@uttily/contracts';
import { PHOTO_SLOT_TYPES } from '@uttily/contracts';
import type { PhotoQualityAssessment } from '../schemas/photo-coach-schema';

export interface AnalyzePhotoInput {
  readonly imageBase64OrDataUrl: string;
  readonly expectedSlot?: PhotoSlotType | string | undefined;
  readonly categorySlug?: string | undefined;
}

export interface PhotoCoachAnalyzer {
  analyzePhoto(input: AnalyzePhotoInput): Promise<PhotoQualityAssessment>;
}

export class FakePhotoCoachAnalyzer implements PhotoCoachAnalyzer {
  constructor(private readonly defaultAssessment?: Partial<PhotoQualityAssessment>) {}

  async analyzePhoto(input: AnalyzePhotoInput): Promise<PhotoQualityAssessment> {
    const slot: PhotoSlotType = (
      typeof input.expectedSlot === 'string' &&
      (PHOTO_SLOT_TYPES as readonly string[]).includes(input.expectedSlot)
        ? input.expectedSlot
        : 'HERO_PROFILE'
    ) as PhotoSlotType;

    // Simulation déterministe basée sur des marqueurs optionnels dans la chaîne
    const isRejectedObject =
      input.imageBase64OrDataUrl.includes('mock_rejected') ||
      input.imageBase64OrDataUrl.includes('mock_glasses') ||
      input.imageBase64OrDataUrl.includes('mock_invalid_object');
    const isBlurry = input.imageBase64OrDataUrl.includes('mock_blurry');
    const isCropped = input.imageBase64OrDataUrl.includes('mock_cropped');
    const isWrongSide = input.imageBase64OrDataUrl.includes('mock_wrong_side');

    if (isRejectedObject) {
      return {
        verdict: 'REJECTED',
        matchedSlot: slot,
        slotConformity: false,
        quality: {
          sharpnessScore: 0,
          exposureScore: 0,
          framingScore: 0,
          backgroundNeutralityScore: 0,
        },
        detectedFeatures: {
          isElectric: false,
          hasLuggageRack: false,
          hasTrailerHitch: false,
          hasChildSeatCompatibleMount: false,
          drivetrainType: 'UNKNOWN',
          brakeType: 'UNKNOWN',
          frameType: 'UNKNOWN',
          confidence: 0,
        },
        issuesFr: [
          'L’objet photographié n’est pas un équipement conforme à la catégorie demandée.',
        ],
        issuesEn: ['The photographed item does not match the requested equipment category.'],
        suggestionsFr: ['Téléversez une photo du vélo entier correspondant au standard demandé.'],
        suggestionsEn: ['Upload a photo of the bicycle matching the required standard.'],
      };
    }

    if (isBlurry) {
      return {
        verdict: 'REJECTED',
        matchedSlot: slot,
        slotConformity: false,
        quality: {
          sharpnessScore: 28,
          exposureScore: 70,
          framingScore: 80,
          backgroundNeutralityScore: 65,
        },
        detectedFeatures: {
          isElectric: false,
          hasLuggageRack: false,
          hasTrailerHitch: false,
          hasChildSeatCompatibleMount: false,
          drivetrainType: 'UNKNOWN',
          brakeType: 'UNKNOWN',
          frameType: 'UNKNOWN',
          confidence: 0.3,
        },
        issuesFr: ['L’image est trop floue pour identifier les composants techniques.'],
        issuesEn: ['Image is too blurry to identify technical components.'],
        suggestionsFr: ['Stabilisez votre appareil ou essuyez l’objectif de votre caméra.'],
        suggestionsEn: ['Hold your camera steady or clean the lens.'],
      };
    }

    if (isCropped) {
      return {
        verdict: 'REJECTED',
        matchedSlot: slot,
        slotConformity: false,
        quality: {
          sharpnessScore: 85,
          exposureScore: 80,
          framingScore: 35,
          backgroundNeutralityScore: 70,
        },
        detectedFeatures: {
          isElectric: true,
          hasLuggageRack: false,
          hasTrailerHitch: false,
          hasChildSeatCompatibleMount: false,
          drivetrainType: 'DERAILLEUR',
          brakeType: 'HYDRAULIC_DISC',
          frameType: 'DIAMOND',
          confidence: 0.6,
        },
        issuesFr: ['La roue avant et le cintre sont coupés du cadre.'],
        issuesEn: ['Front wheel and handlebar are cut off.'],
        suggestionsFr: [
          'Reculez d’environ 1 mètre pour faire entrer l’intégralité du vélo dans le cadre.',
        ],
        suggestionsEn: ['Step back about 1 meter to fit the entire bicycle into the frame.'],
      };
    }

    if (isWrongSide) {
      return {
        verdict: 'WARNING',
        matchedSlot: slot,
        slotConformity: true,
        quality: {
          sharpnessScore: 82,
          exposureScore: 78,
          framingScore: 85,
          backgroundNeutralityScore: 75,
        },
        detectedFeatures: {
          isElectric: true,
          hasLuggageRack: true,
          hasTrailerHitch: false,
          hasChildSeatCompatibleMount: true,
          drivetrainType: 'DERAILLEUR',
          brakeType: 'HYDRAULIC_DISC',
          frameType: 'TRAPEZE',
          confidence: 0.82,
        },
        issuesFr: ['Le vélo est photographié côté opposé à la transmission (dérailleur masqué).'],
        issuesEn: ['Bicycle is photographed from the non-drive side (derailleur hidden).'],
        suggestionsFr: [
          'Tournez le vélo pour photographier la chaîne et le dérailleur face à vous.',
        ],
        suggestionsEn: ['Turn the bike around to show the chain and derailleur.'],
      };
    }

    // Réponse nominale conforme (standard pro validé)
    return {
      verdict: 'CONFORMANT',
      matchedSlot: slot,
      slotConformity: true,
      quality: {
        sharpnessScore: 92,
        exposureScore: 88,
        framingScore: 94,
        backgroundNeutralityScore: 85,
        ...this.defaultAssessment?.quality,
      },
      detectedFeatures: {
        isElectric: true,
        hasLuggageRack: true,
        hasTrailerHitch: false,
        hasChildSeatCompatibleMount: true,
        drivetrainType: 'DERAILLEUR',
        brakeType: 'HYDRAULIC_DISC',
        frameType: 'STEP_THROUGH',
        visibleSizeLabel: 'M',
        confidence: 0.94,
        ...this.defaultAssessment?.detectedFeatures,
      },
      issuesFr: [],
      issuesEn: [],
      suggestionsFr: [
        'Excellente prise de vue, vélo net et parfaitement centré côté transmission.',
      ],
      suggestionsEn: ['Excellent shot, sharp and perfectly centered drive-side bicycle.'],
      ...this.defaultAssessment,
    };
  }
}
