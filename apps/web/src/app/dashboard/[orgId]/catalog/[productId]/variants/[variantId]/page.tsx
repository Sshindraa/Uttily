import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getProductDetails, getMembership, CATALOG_MANAGERS } from '@uttily/core';
import { requireCatalogViewerOf } from '@/lib/catalog-auth';
import { EditVariantForm } from './edit-variant-form';

export default async function EditVariantPage({
  params,
}: {
  params: Promise<{ orgId: string; productId: string; variantId: string }>;
}): Promise<React.ReactElement> {
  const { orgId, productId, variantId } = await params;
  const { db, organizationId, user } = await requireCatalogViewerOf(orgId);
  const details = await getProductDetails(db, organizationId, productId);
  if (details === null) notFound();

  const variant = details.variants.find((v) => v.id === variantId);
  if (variant === undefined) notFound();
  if (variant.productId !== productId) notFound();

  const membership = await getMembership(db, organizationId, user.id);
  const canManage = membership !== null && CATALOG_MANAGERS.includes(membership.role);

  const canDeactivate = canManage && variant.isActive && details.activeVariantCount > 1;

  return (
    <main>
      <h1>Éditer la variante — {variant.name}</h1>
      <p>Produit : {details.product.name}</p>
      {canManage ? (
        <EditVariantForm
          orgId={organizationId}
          productId={productId}
          variant={variant}
          canDeactivate={canDeactivate}
        />
      ) : (
        <dl>
          <dt>Nom</dt>
          <dd>{variant.name}</dd>
          <dt>Suffixe SKU</dt>
          <dd>{variant.skuSuffix ?? '—'}</dd>
          <dt>Statut</dt>
          <dd>{variant.isActive ? 'active' : 'inactive'}</dd>
        </dl>
      )}
      <p>
        <Link href={`/dashboard/${organizationId}/catalog/${productId}`}>Retour au produit</Link>
      </p>
    </main>
  );
}
