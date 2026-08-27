import { listCategories } from '@uttily/core';
import { requireCatalogManagerOf } from '@/lib/catalog-auth';
import { NewBikeForm } from './new-bike-form';

export default async function NewBikePage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const { db, organizationId } = await requireCatalogManagerOf(orgId);

  const categories = await listCategories(db);
  const categoriesList = categories.map((c) => ({ id: c.id, name: c.name }));

  return <NewBikeForm organizationId={organizationId} categories={categoriesList} />;
}
