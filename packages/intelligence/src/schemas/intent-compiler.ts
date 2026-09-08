import { z } from 'zod';
import { createConfidentFieldSchema } from './confidence';

/**
 * Schéma Zod pour la période ou plage horaire extraite.
 */
export const CompiledDateIntentSchema = z.object({
  mode: z.enum(['DAY_RANGE', 'TIME_RANGE']),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  endDateExclusive: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
});

export type CompiledDateIntent = z.infer<typeof CompiledDateIntentSchema>;

/**
 * Schéma Zod pour chaque besoin unitaire d'équipement extrait.
 */
export const CompiledPartyRequirementSchema = z.object({
  categorySlug: z.string().min(1),
  categoryId: z.string().optional(),
  subtypes: z.array(z.string()).optional(),
  targetHeightCm: z.number().int().positive().optional(),
  electricPreferred: z.boolean().optional(),
  accessoryRequired: z
    .enum(['CHILD_TRAILER', 'CHILD_SEAT', 'HELMET', 'PADDLE', 'LIFE_JACKET'])
    .optional(),
});

export type CompiledPartyRequirement = z.infer<typeof CompiledPartyRequirementSchema>;

/**
 * Schéma Zod de la proposition d'intention compilée.
 *
 * Conforme à la politique d'abstention (ADR-041) :
 * Destination, dates et nombre de personnes sont sous forme de champs confiants.
 */
export const IntentProposalSchema = z.object({
  destination: createConfidentFieldSchema(z.string().min(1)),
  destinationPublicId: createConfidentFieldSchema(z.string().min(1)),
  dates: createConfidentFieldSchema(CompiledDateIntentSchema),
  peopleCount: createConfidentFieldSchema(z.number().int().min(1).max(99)),
  requirements: z.array(CompiledPartyRequirementSchema),
  rawQueryCleaned: z.string(),
  explanationFr: z.string().optional(),
  explanationEn: z.string().optional(),
});

export type IntentProposal = z.infer<typeof IntentProposalSchema>;

/**
 * Schémas canoniques pour CompiledIntentProposal (ADR-040 / ADR-041).
 * L'IA extrait faits, inconnues et préférences ; Core construit le PartyModel souverain.
 */
export const ExtractedFactSchema = z.object({
  kind: z.enum(['DESTINATION', 'DATE', 'TIME', 'PARTY_MEMBER', 'EQUIPMENT_NEED']),
  value: z.unknown(),
  confidence: z.number().min(0).max(1),
});
export type ExtractedFact = z.infer<typeof ExtractedFactSchema>;

export const MissingFieldSchema = z.object({
  field: z.enum(['DESTINATION', 'DATES', 'HEIGHT', 'AGE', 'WEIGHT']),
  partyMemberIndex: z.number().int().optional(),
  promptReason: z.string(),
});
export type MissingField = z.infer<typeof MissingFieldSchema>;

export const ProposedPreferenceSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  confidence: z.number().min(0).max(1),
});
export type ProposedPreference = z.infer<typeof ProposedPreferenceSchema>;

export const CompiledIntentProposalSchema = z.object({
  facts: z.array(ExtractedFactSchema),
  unknowns: z.array(MissingFieldSchema),
  preferences: z.array(ProposedPreferenceSchema),
  confidence: z.number().min(0).max(1),
  rawQueryCleaned: z.string(),
  explanationFr: z.string().optional(),
  explanationEn: z.string().optional(),
});
export type CompiledIntentProposal = z.infer<typeof CompiledIntentProposalSchema>;
