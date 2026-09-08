/**
 * @uttily/intelligence — Couche d'intelligence opérationnelle et d'enrichissement multimodal.
 *
 * Conforme à ADR-019 et ADR-040 :
 * - Aucune dépendance de persistance directe (pas d'accès PostgreSQL / Drizzle).
 * - Modèles d'inférence agnostiques échangeables par configuration.
 * - Politique d'abstention explicite (Abstention > hallucination).
 * - Fakes déterministes pour l'exécution hermétique des tests CI.
 */

// Primitives de confiance & politique d'abstention
export {
  type ConfidentField,
  createConfidentFieldSchema,
  abstain,
  confident,
  isConfident,
} from './schemas/confidence';

// Schémas d'enrichissement d'équipement (P0 Scan & List)
export {
  type EquipmentEnrichmentInput,
  type EquipmentEnrichmentProposal,
  type EquipmentEnrichmentImage,
  type EquipmentSpecifications,
  EquipmentEnrichmentInputSchema,
  EquipmentEnrichmentProposalSchema,
  EquipmentEnrichmentImageSchema,
  EquipmentSpecificationsSchema,
} from './schemas/equipment-enrichment';

// Schémas d'intention de recherche (P1 Smart Search)
export {
  type IntentProposal,
  type CompiledDateIntent,
  type CompiledPartyRequirement,
  type CompiledIntentProposal,
  type ExtractedFact,
  type MissingField,
  type ProposedPreference,
  IntentProposalSchema,
  CompiledDateIntentSchema,
  CompiledPartyRequirementSchema,
  CompiledIntentProposalSchema,
  ExtractedFactSchema,
  MissingFieldSchema,
  ProposedPreferenceSchema,
} from './schemas/intent-compiler';

// Ports
export {
  type EquipmentEnrichmentPort,
  type EquipmentEnrichmentExecutionResult,
  type EnrichmentExecutionMetadata,
} from './ports/equipment-enrichment';

export {
  type IntentCompilerPort,
  type IntentCompilerInput,
  type IntentProposal as IntentCompilerProposal,
  type IntentCompilerExecutionResult,
  type AvailableDestinationContext,
  type AvailableCategoryContext,
} from './ports/intent-compiler';

// Fakes déterministes pour les tests
export {
  FakeEquipmentEnrichmentProvider,
  type FakeEquipmentEnrichmentOptions,
  DEFAULT_FAKE_BIKE_PROPOSAL,
  ABSTAINING_FAKE_BIKE_PROPOSAL,
} from './fakes/fake-equipment-enrichment';

export {
  FakeIntentCompilerProvider,
  type FakeIntentCompilerOptions,
  DEFAULT_FAKE_INTENT_PROPOSAL,
} from './fakes/fake-intent-compiler';

// Providers réels
export {
  OpenRouterEquipmentEnrichmentProvider,
  type OpenRouterEquipmentEnrichmentOptions,
} from './providers/openrouter-equipment-enrichment';

export {
  OpenRouterIntentCompilerProvider,
  type OpenRouterIntentCompilerOptions,
} from './providers/openrouter-intent-compiler';

// Photo Quality Coach (G8B-3 / Phase 2)
export {
  type PhotoCoachVerdict,
  type DrivetrainType,
  type BrakeType,
  type FrameType,
  type DetectedEquipmentFeatures,
  type QualityMetrics,
  type PhotoQualityAssessment,
  PhotoCoachVerdictSchema,
  DrivetrainTypeSchema,
  BrakeTypeSchema,
  FrameTypeSchema,
  DetectedEquipmentFeaturesSchema,
  QualityMetricsSchema,
  PhotoQualityAssessmentSchema,
} from './schemas/photo-coach-schema';

export { PHOTO_COACH_SYSTEM_PROMPT } from './prompts/photo-coach-prompt';

export {
  FakePhotoCoachAnalyzer,
  type AnalyzePhotoInput,
  type PhotoCoachAnalyzer,
} from './fakes/fake-photo-coach';

export {
  OpenRouterPhotoCoachAnalyzer,
  type OpenRouterPhotoCoachOptions,
} from './providers/openrouter-photo-coach';
