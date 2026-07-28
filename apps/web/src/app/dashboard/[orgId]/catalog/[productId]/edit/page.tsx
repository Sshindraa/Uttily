import { notFound } from 'next/navigation';
import { getProductDetails, listActiveCategories, getCategory } from '@uttily/core';
import { requireCatalogManagerOf } from '@/lib/catalog-auth';
import { EditProductForm } from './edit-product-form';

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ orgId: string; productId: string }>;
}): Promise<React.ReactElement> {
  const { orgId, productId } = await params;
  const { db, organizationId } = await requireCatalogManagerOf(orgId);
  const details = await getProductDetails(db, organizationId, productId);
  if (details === null) notFound();
  const categories = await listActiveCategories(db);

  const currentCategoryId = details.product.categoryId;
  let inactiveCategory: { id: string; name: string } | null = null;
  if (currentCategoryId && !categories.some((c) => c.id === currentCategoryId)) {
    const cat = await getCategory(db, currentCategoryId);
    if (cat !== null) {
      inactiveCategory = { id: cat.id, name: cat.name };
    }
  }

  return (
    <main>
      <h1>Éditer le produit</h1>
      <EditProductForm
        orgId={organizationId}
        categories={categories}
        product={details.product}
        inactiveCategory={inactiveCategory}
      />
    </main>
  );
}
