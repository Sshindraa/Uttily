export interface AvailableDestinationContext {
  readonly publicId: string;
  readonly label: string;
  readonly slug: string;
}

export interface AvailableCategoryContext {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

/**
 * Entrée de compilation d'intention en langage naturel (P1).
 */
export interface IntentCompilerInput {
  readonly rawQuery: string;
  readonly locale: 'fr' | 'en';
  readonly userContext?: {
    readonly userLocation?: { readonly lat: number; readonly lng: number };
    readonly currentDateTimeIso?: string;
    readonly availableDestinations?: readonly AvailableDestinationContext[];
    readonly availableCategories?: readonly AvailableCategoryContext[];
  };
}

import type {
  IntentProposal,
  CompiledDateIntent,
  CompiledPartyRequirement,
} from '../schemas/intent-compiler';

export type {
  IntentProposal,
  CompiledDateIntent,
  CompiledPartyRequirement,
};

/**
 * Résultat d'exécution du compilateur d'intention.
 */
export interface IntentCompilerExecutionResult {
  readonly proposal: IntentProposal;
  readonly latencyMs: number;
  readonly model: string;
}

/**
 * Port de compilation d'intention (P1 Intent Compiler).
 */
export interface IntentCompilerPort {
  compileIntent(input: IntentCompilerInput): Promise<IntentCompilerExecutionResult>;
}
