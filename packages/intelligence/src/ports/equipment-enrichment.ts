import type {
  EquipmentEnrichmentInput,
  EquipmentEnrichmentProposal,
} from '../schemas/equipment-enrichment';

/**
 * Métadonnées d'exécution et de provenance associées à une inférence d'enrichissement.
 */
export interface EnrichmentExecutionMetadata {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly providerRequestId?: string;
  readonly latencyMs: number;
  readonly inputUnits?: number;
  readonly outputUnits?: number;
  readonly costMicrounits?: number;
}

/**
 * Résultat complet retourné par le port d'enrichissement.
 */
export interface EquipmentEnrichmentExecutionResult {
  readonly proposal: EquipmentEnrichmentProposal;
  readonly metadata: EnrichmentExecutionMetadata;
  readonly inputFingerprint: string;
}

/**
 * Port d'enrichissement d'équipement (P0 Scan & List).
 *
 * Conforme à l'architecture hexagonale d'ADR-041 :
 * - Aucune dépendance à une base de données.
 * - Entrée pure, sortie purement en mémoire.
 */
export interface EquipmentEnrichmentPort {
  enrichEquipment(input: EquipmentEnrichmentInput): Promise<EquipmentEnrichmentExecutionResult>;
}
