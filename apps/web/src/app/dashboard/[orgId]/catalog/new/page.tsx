import { listActiveCategories } from '@uttily/core';
import { requireCatalogManagerOf } from '@/lib/catalog-auth';
import { NewProductForm } from './new-product-form';

export default async function NewProductPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { db, organizationId } = await requireCatalogManagerOf((await params).orgId);
  const categories = await listActiveCategories(db);

  return (
    <main>
      <h1>Nouveau produit</h1>
      <NewProductForm orgId={organizationId} categories={categories} />
    </main>
  );
}
