import { listMaintenanceCases } from '@uttily/core';
import { requireCatalogViewerOf } from '@/lib/catalog-auth';
import { MaintenanceListView } from '@/features/fleet';

export default async function MaintenanceListPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { db, organizationId } = await requireCatalogViewerOf((await params).orgId);
  const cases = await listMaintenanceCases(db, organizationId);

  return <MaintenanceListView organizationId={organizationId} cases={cases} />;
}
