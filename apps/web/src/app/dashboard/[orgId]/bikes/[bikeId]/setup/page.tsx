import { notFound } from 'next/navigation';
import {
  getUnifiedBike,
  resolveBikeSetupProgress,
  listCategories,
  listLocations,
} from '@uttily/core';
import { requireCatalogManagerOf } from '@/lib/catalog-auth';
import type { PricingPlanType } from '@/lib/status-presentation';
import { BikeSetupWizard, type SetupBikeDTO } from './bike-setup-wizard';

export default async function BikeSetupPage({
  params,
}: {
  params: Promise<{ orgId: string; bikeId: string }>;
}): Promise<React.ReactElement> {
  const { orgId, bikeId } = await params;
  const { db, organizationId } = await requireCatalogManagerOf(orgId);

  const bike = await getUnifiedBike(db, organizationId, bikeId);
  if (bike === null) notFound();

  const progress = resolveBikeSetupProgress(bike);

  const [categoriesList, locationsList] = await Promise.all([
    listCategories(db),
    listLocations(db, organizationId),
  ]);

  const categories = categoriesList.map((c) => ({ id: c.id, name: c.name }));
  const locations = locationsList.map((l) => ({ id: l.id, name: l.name }));

  const activePlan = bike.pricing.activePlan ?? bike.pricing.draftPlan;
  const priceEuros = activePlan ? activePlan.priceAmountMinor / 100 : null;

  const bikeDTO: SetupBikeDTO = {
    id: bike.product.id,
    name: bike.product.name,
    description: bike.product.description ?? '',
    categoryId: bike.product.categoryId,
    categoryName: bike.product.categoryName,
    variantId: bike.variant.id,
    variantName: bike.variant.name,
    photos: bike.photos.items.map((p) => ({
      id: p.id,
      publicId: p.publicId,
      sortOrder: p.sortOrder,
    })),
    isPhotosComplete: bike.photos.isComplete,
    currentPriceEuros: priceEuros,
    pricingPlanType: activePlan?.planType as PricingPlanType | null,
    pricingCurrency: activePlan?.currency ?? bike.variant.currency,
    draftPricingPlanId: bike.pricing.draftPlan?.id ?? null,
    discountTiers: activePlan?.discountTiers,
    inventoryCount: bike.inventory.totalCount,
    isPublicationReady: bike.publication.ready,
    publicationFailures: bike.publication.failures,
  };

  return (
    <BikeSetupWizard
      organizationId={organizationId}
      bike={bikeDTO}
      initialStep={progress.nextStep}
      categories={categories}
      locations={locations}
    />
  );
}
