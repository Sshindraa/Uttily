import { listCategories } from '@uttily/core';
import { requireCatalogManagerOf } from '@/lib/catalog-auth';
import { NewBikeForm } from '@/features/bikes';

export default async function NewBikePage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const { db, organizationId } = await requireCatalogManagerOf(orgId);

  const categories = await listCategories(db);
  const categoriesList = categories.map((c) => ({ id: c.id, name: c.name, slug: c.slug }));

  return <NewBikeForm organizationId={organizationId} categories={categoriesList} />;
}
