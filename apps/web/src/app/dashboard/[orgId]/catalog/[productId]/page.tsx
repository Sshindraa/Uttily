import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getProductDetails, getMembership, CATALOG_MANAGERS } from '@uttily/core';
import { requireCatalogViewerOf } from '@/lib/catalog-auth';
import { ProductActions } from './product-actions';

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ orgId: string; productId: string }>;
}): Promise<React.ReactElement> {
  const { orgId, productId } = await params;
  const { db, organizationId, user } = await requireCatalogViewerOf(orgId);
  const details = await getProductDetails(db, organizationId, productId);
  if (details === null) notFound();

  const membership = await getMembership(db, organizationId, user.id);
  const canManage = membership !== null && CATALOG_MANAGERS.includes(membership.role);

  const {
    product,
    category,
    variants,
    activeVariantCount,
    activeInventoryCount,
    publicationReadiness,
  } = details;

  return (
    <main>
      <h1>{product.name}</h1>
      <p>
        Statut : <strong>{product.publicationStatus}</strong>
      </p>
      <p>Slug : {product.slug}</p>
      <p>Catégorie : {category.name}</p>
      {product.description && <p>Description : {product.description}</p>}
      <p>Variantes actives : {activeVariantCount}</p>
      <p>Exemplaires actifs : {activeInventoryCount}</p>

      {product.publicationStatus === 'DRAFT' && (
        <section aria-labelledby="readiness-heading">
          <h2 id="readiness-heading">Prêt à publier</h2>
          {publicationReadiness.ready ? (
            <p>Tous les prérequis sont remplis.</p>
          ) : (
            <ul>
              {publicationReadiness.failures.map((failure) => (
                <li key={failure}>{failure}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {canManage && (
        <section aria-labelledby="actions-heading">
          <h2 id="actions-heading">Actions</h2>
          <ProductActions
            orgId={organizationId}
            productId={product.id}
            status={product.publicationStatus}
            ready={publicationReadiness.ready}
          />
          <p>
            <Link href={`/dashboard/${organizationId}/catalog/${product.id}/edit`}>Éditer</Link>
          </p>
        </section>
      )}

      <section aria-labelledby="variants-heading">
        <h2 id="variants-heading">Variantes</h2>
        {canManage && (
          <p>
            <Link href={`/dashboard/${organizationId}/catalog/${product.id}/variants/new`}>
              Ajouter une variante
            </Link>
          </p>
        )}
        {variants.length === 0 ? (
          <p>Aucune variante.</p>
        ) : (
          <ul>
            {variants.map((variant) => (
              <li key={variant.id}>
                <Link
                  href={`/dashboard/${organizationId}/catalog/${product.id}/variants/${variant.id}`}
                >
                  {variant.name}
                </Link>
                {variant.skuSuffix ? ` — ${variant.skuSuffix}` : ''}
                {' — '}
                {variant.isActive ? 'active' : 'inactive'}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p>
        <Link href={`/dashboard/${organizationId}/catalog`}>Retour au catalogue</Link>
      </p>
    </main>
  );
}
