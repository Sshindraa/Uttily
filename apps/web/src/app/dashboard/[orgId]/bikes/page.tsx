import { listUnifiedBikes, getMembership, CATALOG_MANAGERS } from '@uttily/core';
import { requireCatalogViewerOf } from '@/lib/catalog-auth';
import { BikesListView } from '@/features/bikes';

export default async function BikesListPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const { db, organizationId, user } = await requireCatalogViewerOf(orgId);

  const bikes = await listUnifiedBikes(db, organizationId);
  const membership = await getMembership(db, organizationId, user.id);
  const canManage = membership !== null && CATALOG_MANAGERS.includes(membership.role);

  return <BikesListView organizationId={organizationId} bikes={bikes} canManage={canManage} />;
}
