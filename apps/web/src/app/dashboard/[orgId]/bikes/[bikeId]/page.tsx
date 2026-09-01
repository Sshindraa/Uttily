import { notFound } from 'next/navigation';
import { getUnifiedBike, listCommerciallyActiveCategories, listLocations } from '@uttily/core';
import { requireCatalogViewerOf } from '@/lib/catalog-auth';
import { BikeDetailView } from '@/features/bikes';

export default async function UnifiedBikePage({
  params,
}: {
  params: Promise<{ orgId: string; bikeId: string }>;
}): Promise<React.ReactElement> {
  const { orgId, bikeId } = await params;
  const { db, organizationId } = await requireCatalogViewerOf(orgId);

  const bike = await getUnifiedBike(db, organizationId, bikeId);
  if (bike === null) notFound();

  const [categoriesList, locationsList] = await Promise.all([
    listCommerciallyActiveCategories(db),
    listLocations(db, organizationId),
  ]);

  const categories = categoriesList.map((c) => ({ id: c.id, name: c.name, slug: c.slug }));
  const locations = locationsList.map((l) => ({ id: l.id, name: l.name }));

  return (
    <BikeDetailView
      organizationId={organizationId}
      bike={bike}
      categories={categories}
      locations={locations}
    />
  );
}
