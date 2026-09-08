/**
 * Instrumentation Produit & Métriques Pack Orchestrator (ADR-041).
 *
 * Mesure l'utilité réelle et la promesse produit :
 * « Quel pourcentage des intentions multi-besoins Uttily transforme-t-il
 *   en une solution mono-loueur réellement réservable ? »
 */

export interface PackSearchMetricsEvent {
  readonly eventName:
    | 'pack_search_executed'
    | 'pack_candidate_found'
    | 'pack_zero_solution'
    | 'pack_selected'
    | 'pack_repair_selected'
    | 'pack_hold_success'
    | 'pack_hold_failure'
    | 'pack_checkout_started'
    | 'pack_checkout_completed';
  readonly destinationPublicId?: string | undefined;
  readonly peopleCount: number;
  readonly itemsCount?: number | undefined;
  readonly totalPackPriceCents?: number | undefined;
  readonly organizationId?: string | undefined;
  readonly isRepaired?: boolean | undefined;
  readonly latencyMs?: number | undefined;
  readonly timestamp: string;
}

export interface PackFunnelKPIs {
  readonly packSearchRate: number;
  readonly exactPackFoundRate: number;
  readonly repairedPackFoundRate: number;
  readonly zeroSolutionRate: number;
  readonly packSelectedRate: number;
  readonly packHoldSuccessRate: number;
  readonly averagePackItems: number;
  readonly averagePackValueCents: number;
}

/**
 * Enregistre un événement analytique Pack Orchestrator.
 */
export function recordPackAnalytics(event: Omit<PackSearchMetricsEvent, 'timestamp'>): PackSearchMetricsEvent {
  const payload: PackSearchMetricsEvent = {
    ...event,
    timestamp: new Date().toISOString(),
  };

  // Traçage structuré pour observabilité
  if (process.env.NODE_ENV !== 'test') {
    // eslint-disable-next-line no-console
    console.info('[PackOrchestrator:Analytics]', JSON.stringify(payload));
  }

  return payload;
}
