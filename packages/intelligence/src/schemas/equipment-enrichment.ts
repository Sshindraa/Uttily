import { z } from 'zod';
import {
  PHOTO_SLOT_TYPES,
  INVENTORY_CONDITIONS,
} from '@uttily/contracts';
import {
  createConfidentFieldSchema,
} from './confidence';

/**
 * Image fournie en entrée du Copilot d'enrichissement.
 */
export const EquipmentEnrichmentImageSchema = z.object({
  url: z.string().url().optional(),
  base64: z.string().optional(),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']).default('image/jpeg'),
}).refine((data) => data.url || data.base64, {
  message: "Au moins une URL ou une charge base64 doit être fournie pour chaque image.",
});

export type EquipmentEnrichmentImage = z.infer<typeof EquipmentEnrichmentImageSchema>;

/**
 * Données d'entrée pour la demande d'enrichissement d'équipement (P0 Scan & List).
 */
export const EquipmentEnrichmentInputSchema = z.object({
  organizationId: z.string().uuid(),
  images: z.array(EquipmentEnrichmentImageSchema).min(1).max(5),
  contextHint: z.string().max(1000).optional(),
  locale: z.enum(['fr', 'en']).default('fr'),
});

export type EquipmentEnrichmentInput = z.infer<typeof EquipmentEnrichmentInputSchema>;

/**
 * Schéma Zod des spécifications techniques détectées (moteur, batterie, transmission, etc.).
 */
export const EquipmentSpecificationsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);

export type EquipmentSpecifications = z.infer<typeof EquipmentSpecificationsSchema>;

/**
 * Proposition structurée générée par le modèle multimodal (VLM).
 *
 * Toutes les valeurs sont probabilistes et protégées par la politique d'abstention
 * d'ADR-041. Le pricing est formellement exclu de la v1.
 */
export const EquipmentEnrichmentProposalSchema = z.object({
  /** Marque du fabricant (ex: Specialized, Trek, Moustache, Rossignol) */
  brand: createConfidentFieldSchema(z.string().min(1).max(100)),

  /** Modèle commercial exact (ex: Turbo Levo Comp Alloy) */
  model: createConfidentFieldSchema(z.string().min(1).max(150)),

  /** Famille taxonomique fermée Uttily (ex: bike, kayak, surf, ski, etc.) */
  categorySlug: createConfidentFieldSchema(z.string().min(1).max(50)),

  /** Sous-type descriptif d'équipement (ex: electric_mountain, road, all_mountain) */
  subtype: createConfidentFieldSchema(z.string().min(1).max(50)),

  /** Taille de cadre / d'équipement détectée (ex: S, M, L, 54, 56) */
  frameSize: createConfidentFieldSchema(z.string().min(1).max(30)),

  /** Spécifications techniques détectées (batterie, moteur, freins, etc.) */
  specifications: createConfidentFieldSchema(EquipmentSpecificationsSchema),

  /** Descriptif commercial attractif généré en français */
  marketingDescriptionFr: createConfidentFieldSchema(z.string().min(10).max(2000)),

  /** Descriptif commercial attractif généré en anglais */
  marketingDescriptionEn: createConfidentFieldSchema(z.string().min(10).max(2000)),

  /** État physique suggéré d'après l'analyse visuelle */
  suggestedCondition: createConfidentFieldSchema(z.enum(INVENTORY_CONDITIONS)),

  /** Angle de vue détecté pour la photo principale d'après les slots normés */
  detectedPhotoSlot: createConfidentFieldSchema(z.enum(PHOTO_SLOT_TYPES)),

  /** Résumé du raisonnement global et avertissements éventuels */
  generalObservations: z.string().optional(),
});

export type EquipmentEnrichmentProposal = z.infer<typeof EquipmentEnrichmentProposalSchema>;
