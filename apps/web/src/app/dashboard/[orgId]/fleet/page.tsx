import {
  listInventorySummaries,
  listLocations,
  getMembership,
  CATALOG_MANAGERS,
} from '@uttily/core';
import { requireCatalogViewerOf } from '@/lib/catalog-auth';
import { FleetListView } from '@/features/fleet';

export default async function FleetListPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { db, organizationId, user } = await requireCatalogViewerOf((await params).orgId);
  const [items, locations] = await Promise.all([
    listInventorySummaries(db, organizationId),
    listLocations(db, organizationId),
  ]);
  const membership = await getMembership(db, organizationId, user.id);
  const canManage = membership !== null && CATALOG_MANAGERS.includes(membership.role);

  return (
    <FleetListView
      organizationId={organizationId}
      items={items}
      locations={locations.map((location) => ({
        id: location.id,
        name: location.name,
        timeZone: location.timeZone,
      }))}
      canManage={canManage}
    />
  );
}
