import { listInventorySummaries, getMembership, CATALOG_MANAGERS } from '@uttily/core';
import { requireCatalogViewerOf } from '@/lib/catalog-auth';
import { FleetListView } from '@/features/fleet';

export default async function FleetListPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { db, organizationId, user } = await requireCatalogViewerOf((await params).orgId);
  const items = await listInventorySummaries(db, organizationId);
  const membership = await getMembership(db, organizationId, user.id);
  const canManage = membership !== null && CATALOG_MANAGERS.includes(membership.role);

  return <FleetListView organizationId={organizationId} items={items} canManage={canManage} />;
}
