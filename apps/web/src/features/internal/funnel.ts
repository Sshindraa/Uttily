import type { ProductAnalyticsSummary, ResolvedAnalyticsEnvironment } from '@uttily/core';
import type { MaintenanceAnalyticsEnvironment } from '@/lib/product-analytics-maintenance';

export type FunnelRangeDays = 7 | 30;
export const FUNNEL_RANGES: readonly FunnelRangeDays[] = [7, 30];
export const DEFAULT_FUNNEL_RANGE: FunnelRangeDays = 7;
export const FUNNEL_ENVIRONMENTS: readonly MaintenanceAnalyticsEnvironment[] = [
  'DEVELOPMENT',
  'TEST',
];
export const PRODUCTION_COLLECTION_NOTICE =
  "Collecte PRODUCTION désactivée : aucune donnée de production n'est collectée, agrégée ni affichée dans cette page.";

export interface FunnelWindow {
  fromDay: string;
  toDayExclusive: string;
}

export interface FunnelRatios {
  searchToResultRate: number | null;
  attemptToConfirmationRate: number | null;
}

export interface FunnelEnvironmentView {
  environment: MaintenanceAnalyticsEnvironment;
  summary: ProductAnalyticsSummary;
  ratios: FunnelRatios;
}

export interface InternalFunnelView {
  rangeDays: FunnelRangeDays;
  window: FunnelWindow;
  collectionEnvironment: ResolvedAnalyticsEnvironment;
  productionCollectionEnabled: false;
  productionNotice: string;
  environments: FunnelEnvironmentView[];
}

export interface BuildInternalFunnelViewInput {
  rangeDays: FunnelRangeDays;
  window: FunnelWindow;
  collectionEnvironment: ResolvedAnalyticsEnvironment;
  summaries: Record<MaintenanceAnalyticsEnvironment, ProductAnalyticsSummary>;
}

export function parseFunnelRange(value: string | undefined): FunnelRangeDays {
  if (value === '30') return 30;
  return DEFAULT_FUNNEL_RANGE;
}

export function resolveFunnelWindow(now: Date, days: FunnelRangeDays): FunnelWindow {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(today.getTime());
  from.setUTCDate(from.getUTCDate() - (days - 1));
  const toExclusive = new Date(today.getTime());
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);

  return {
    fromDay: from.toISOString().slice(0, 10),
    toDayExclusive: toExclusive.toISOString().slice(0, 10),
  };
}

export function deriveFunnelRatios(summary: ProductAnalyticsSummary): FunnelRatios {
  return {
    searchToResultRate:
      summary.searches === 0 ? null : summary.searchesWithResults / summary.searches,
    attemptToConfirmationRate:
      summary.bookingAttempts === 0 ? null : summary.bookingsConfirmed / summary.bookingAttempts,
  };
}

export function formatFunnelRate(rate: number | null): string {
  if (rate === null) return '—';
  return `${(rate * 100).toFixed(1).replace('.', ',')} %`;
}

export function formatFunnelCount(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return '—';
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function buildInternalFunnelView(input: BuildInternalFunnelViewInput): InternalFunnelView {
  const environments: FunnelEnvironmentView[] = FUNNEL_ENVIRONMENTS.map((environment) => ({
    environment,
    summary: input.summaries[environment],
    ratios: deriveFunnelRatios(input.summaries[environment]),
  }));

  return {
    rangeDays: input.rangeDays,
    window: input.window,
    collectionEnvironment: input.collectionEnvironment,
    productionCollectionEnabled: false,
    productionNotice: PRODUCTION_COLLECTION_NOTICE,
    environments,
  };
}
