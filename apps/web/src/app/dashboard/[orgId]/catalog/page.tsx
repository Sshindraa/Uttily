import Link from 'next/link';
import { listProductSummaries, getMembership, CATALOG_MANAGERS } from '@uttily/core';
import { requireCatalogViewerOf } from '@/lib/catalog-auth';

export default async function CatalogListPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { db, organizationId, user } = await requireCatalogViewerOf((await params).orgId);
  const products = await listProductSummaries(db, organizationId);
  const membership = await getMembership(db, organizationId, user.id);
  const canManage = membership !== null && CATALOG_MANAGERS.includes(membership.role);

  return (
    <main>
      <h1>Catalogue</h1>
      {canManage && (
        <Link href={`/dashboard/${organizationId}/catalog/new`}>Ajouter un produit</Link>
      )}
      {products.length === 0 ? (
        <p>Aucun produit.</p>
      ) : (
        <ul>
          {products.map((product) => (
            <li key={product.id}>
              <Link href={`/dashboard/${organizationId}/catalog/${product.id}`}>
                {product.name}
              </Link>
              {' — '}
              {product.publicationStatus}
              {' — '}
              {product.categoryName}
              {' — variantes actives : '}
              {product.activeVariantCount}
              {' — exemplaires actifs : '}
              {product.activeInventoryCount}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
