import { z } from 'zod';
import { PHOTO_SLOT_TYPES } from '@uttily/contracts';

export const PhotoCoachVerdictSchema = z.enum(['CONFORMANT', 'WARNING', 'REJECTED']);
export type PhotoCoachVerdict = z.infer<typeof PhotoCoachVerdictSchema>;

export const DrivetrainTypeSchema = z.enum(['DERAILLEUR', 'HUB_INTERNAL', 'BELT', 'UNKNOWN']);
export type DrivetrainType = z.infer<typeof DrivetrainTypeSchema>;

export const BrakeTypeSchema = z.enum(['HYDRAULIC_DISC', 'MECHANICAL_DISC', 'RIM_BRAKE', 'UNKNOWN']);
export type BrakeType = z.infer<typeof BrakeTypeSchema>;

export const FrameTypeSchema = z.enum(['STEP_THROUGH', 'TRAPEZE', 'DIAMOND', 'CARGO', 'UNKNOWN']);
export type FrameType = z.infer<typeof FrameTypeSchema>;

export const DetectedEquipmentFeaturesSchema = z.object({
  isElectric: z.boolean().describe('Détection visuelle formelle d’une assistance électrique (moteur pédalier/moyeu, batterie visible, console au guidon)'),
  hasLuggageRack: z.boolean().describe('Présence visible d’un porte-bagages arrière'),
  hasTrailerHitch: z.boolean().describe('Présence visible d’un adaptateur ou fixation d’attelage remorque sur l’axe arrière'),
  hasChildSeatCompatibleMount: z.boolean().describe('Présence d’un espace de fixation adapté pour siège bébé sur cadre ou porte-bagages'),
  drivetrainType: DrivetrainTypeSchema.describe('Type de transmission'),
  brakeType: BrakeTypeSchema.describe('Type de système de freinage'),
  frameType: FrameTypeSchema.describe('Géométrie du cadre (col de cygne, trapèze, diamant/sport, cargo)'),
  visibleSizeLabel: z.string().nullable().optional().describe('Taille visible sur le cadre (ex: S, M, L, XL, 52, 54 cm) si lisible sans doute'),
  confidence: z.number().min(0).max(1).describe('Indice global de confiance de l’extraction visuelle'),
});
export type DetectedEquipmentFeatures = z.infer<typeof DetectedEquipmentFeaturesSchema>;

export const QualityMetricsSchema = z.object({
  sharpnessScore: z.number().min(0).max(100).describe('Score de netteté et mise au point (0 = flou inexploitable, 100 = netteté parfaite)'),
  exposureScore: z.number().min(0).max(100).describe('Score d’exposition et d’éclairage (0 = sous-exposé / contre-jour violent, 100 = équilibré)'),
  framingScore: z.number().min(0).max(100).describe('Score de cadrage (0 = équipement tronqué / coupé, 100 = équipement complet centré)'),
  backgroundNeutralityScore: z.number().min(0).max(100).describe('Score de propreté de l’arrière-plan (0 = encombré / parasite, 100 = fond sobre ou dégagé)'),
});
export type QualityMetrics = z.infer<typeof QualityMetricsSchema>;

export const PhotoQualityAssessmentSchema = z.object({
  verdict: PhotoCoachVerdictSchema.describe('Verdict global de publication'),
  matchedSlot: z.enum(PHOTO_SLOT_TYPES).describe('Slot sémantique détecté dans l’image (ex: HERO_PROFILE, THREE_QUARTER_FRONT, SECONDARY_VIEW)'),
  slotConformity: z.boolean().describe('Indique si la photo respecte l’angle et les exigences du slot demandé'),
  quality: QualityMetricsSchema,
  detectedFeatures: DetectedEquipmentFeaturesSchema,
  issuesFr: z.array(z.string()).describe('Liste des défauts constatés en français'),
  issuesEn: z.array(z.string()).describe('Liste des défauts constatés en anglais'),
  suggestionsFr: z.array(z.string()).describe('Conseils pratiques d’amélioration en atelier (français)'),
  suggestionsEn: z.array(z.string()).describe('Conseils pratiques d’amélioration en atelier (anglais)'),
});
export type PhotoQualityAssessment = z.infer<typeof PhotoQualityAssessmentSchema>;
