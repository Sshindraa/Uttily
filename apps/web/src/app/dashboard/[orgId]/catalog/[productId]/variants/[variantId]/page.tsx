import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getProductDetails,
  getMembership,
  CATALOG_MANAGERS,
  getVariantPricingSummary,
} from '@uttily/core';
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
  const pricingOverview = await getVariantPricingSummary(db, organizationId, variantId);

  return (
    <main>
      <h1>Éditer la variante — {variant.name}</h1>
      <p>Produit : {details.product.name}</p>

      <section
        aria-labelledby="pricing-heading"
        style={{
          margin: '20px 0',
          padding: '16px',
          background: '#f8fafc',
          border: '1px solid #e2e8f0',
          borderRadius: '12px',
        }}
      >
        <h2 id="pricing-heading" style={{ fontSize: '1.1rem', margin: '0 0 8px 0' }}>
          Tarification
        </h2>
        {pricingOverview.activePlan ? (
          <p style={{ margin: '0 0 8px 0' }}>
            Tarif actif :{' '}
            <strong>
              {(pricingOverview.activePlan.priceAmountMinor / 100).toFixed(2)} € / jour
            </strong>{' '}
            (Version {pricingOverview.activePlan.version})
          </p>
        ) : pricingOverview.draftPlan ? (
          <p style={{ margin: '0 0 8px 0', color: '#d97706' }}>
            Brouillon en attente d’activation :{' '}
            <strong>
              {(pricingOverview.draftPlan.priceAmountMinor / 100).toFixed(2)} € / jour
            </strong>
          </p>
        ) : (
          <p style={{ margin: '0 0 8px 0', color: '#64748b' }}>
            Aucun tarif défini pour cette variante.
          </p>
        )}
        <p style={{ margin: 0 }}>
          <Link
            href={`/dashboard/${organizationId}/catalog/${productId}/variants/${variantId}/pricing`}
            style={{ fontWeight: 700, color: '#0284c7' }}
          >
            💳 {pricingOverview.activePlan ? 'Modifier le tarif' : 'Définir le tarif'}
          </Link>
        </p>
      </section>

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
