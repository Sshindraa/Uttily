import { requireSupportPlatformAdmin } from '@/lib/support-auth';
import { getAnalyticsEnvironment } from '@/lib/product-analytics';
import { getProductAnalyticsSummary } from '@uttily/core';
import type { ProductAnalyticsSummary } from '@uttily/core';
import type { MaintenanceAnalyticsEnvironment } from '@/lib/product-analytics-maintenance';
import {
  AnalyticsSupportView,
  buildInternalFunnelView,
  FUNNEL_ENVIRONMENTS,
  parseFunnelRange,
  resolveFunnelWindow,
} from '@/features/internal';

export const dynamic = 'force-dynamic';

/**
 * Surface interne Uttily — funnel produit agrégé (Chantier 18-A).
 *
 * Strictement réservée à l'équipe interne : la garde `requireSupportPlatformAdmin`
 * est ré-appliquée ici (défense en profondeur en plus du layout /internal).
 * Un utilisateur Pro, même OWNER, est rejeté.
 *
 * La page n'affiche QUE les quatre compteurs privacy-safe agrégés par Core.
 * Aucune dimension personnelle n'est lue ni rendue.
 */
export default async function InternalAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}): Promise<React.ReactElement> {
  const { db } = await requireSupportPlatformAdmin();
  const { range } = await searchParams;

  const rangeDays = parseFunnelRange(range);
  const window = resolveFunnelWindow(new Date(), rangeDays);

  const summaries = {} as Record<MaintenanceAnalyticsEnvironment, ProductAnalyticsSummary>;
  for (const environment of FUNNEL_ENVIRONMENTS) {
    summaries[environment] = await getProductAnalyticsSummary(db, {
      environment,
      fromDay: window.fromDay,
      toDayExclusive: window.toDayExclusive,
    });
  }

  const view = buildInternalFunnelView({
    rangeDays,
    window,
    collectionEnvironment: getAnalyticsEnvironment(),
    summaries,
  });

  return <AnalyticsSupportView view={view} />;
}
