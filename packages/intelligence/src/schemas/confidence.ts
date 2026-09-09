import { z } from 'zod';

/**
 * Encapsulation canonique d'un champ probabiliste produit par un modèle VLM / LLM.
 *
 * Conforme à la politique d'abstention d'ADR-041 (Abstention > hallucination) :
 * - `value` est nullable (`null` quand le modèle s'abstient ou manque de certitude).
 * - `confidence` est un score normalisé entre 0.0 et 1.0.
 * - `reasoning` documente de manière factuelle la déduction (ex: "Logo Shimano Deore visible sur dérailleur").
 */
export interface ConfidentField<T> {
  readonly value: T | null;
  readonly confidence: number;
  readonly reasoning?: string;
}

/**
 * Constructeur de schéma Zod pour un champ probabiliste typé.
 */
export function createConfidentFieldSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.object({
    value: valueSchema.nullable(),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().optional(),
  });
}

/**
 * Crée un champ abstenu (« je ne sais pas / non déterminable »).
 */
export function abstain<T>(reasoning?: string): ConfidentField<T> {
  return {
    value: null,
    confidence: 0,
    ...(reasoning ? { reasoning } : {}),
  };
}

/**
 * Crée un champ confiant avec score explicite.
 */
export function confident<T>(value: T, confidence: number, reasoning?: string): ConfidentField<T> {
  return {
    value,
    confidence: Math.max(0, Math.min(1, confidence)),
    ...(reasoning ? { reasoning } : {}),
  };
}

/**
 * Vérifie si un champ satisfait un seuil de confiance minimal pour pré-remplir l'interface.
 */
export function isConfident<T>(
  field: ConfidentField<T> | undefined | null,
  minConfidence = 0.75,
): field is ConfidentField<T> & { value: NonNullable<T> } {
  return field != null && field.value !== null && field.confidence >= minConfidence;
}
