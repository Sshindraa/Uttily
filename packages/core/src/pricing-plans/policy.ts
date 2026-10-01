/**
 * Politiques de périmètre applicables au moteur de tarification flexible.
 *
 * Le moteur reste générique par défaut. Une politique explicite peut être
 * injectée par une surface applicative lorsqu'un périmètre commercial plus
 * restreint est nécessaire, comme pour le premier pilote.
 */

export type PricingPlanType = 'HOURLY' | 'FIXED_DURATION' | 'DAILY';

export interface PricingPlanPolicy {
  readonly excludedPlanTypes?: readonly PricingPlanType[];
}

/**
 * Périmètre tarifaire du premier pilote commercial.
 *
 * La décision métier du 2026-09-04 exclut les offres horaires de ce pilote.
 * Les plans forfaitaires et journaliers restent éligibles sous réserve des
 * autres garde-fous de publication, de disponibilité et de réservation.
 */
export const FIRST_PILOT_PRICING_POLICY: PricingPlanPolicy = Object.freeze({
  excludedPlanTypes: ['HOURLY'] as const,
});

export function isPricingPlanAllowed(
  planType: PricingPlanType,
  policy: PricingPlanPolicy | undefined,
): boolean {
  return !policy?.excludedPlanTypes?.includes(planType);
}
