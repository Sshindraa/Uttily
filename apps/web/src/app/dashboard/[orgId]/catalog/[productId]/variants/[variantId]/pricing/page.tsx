import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getProductDetails,
  getMembership,
  CATALOG_MANAGERS,
  getVariantPricingSummary,
} from '@uttily/core';
import { requireCatalogViewerOf } from '@/lib/catalog-auth';
import { PricingForm } from './pricing-form';
import styles from './pricing.module.css';

export default async function VariantPricingPage({
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

  const overview = await getVariantPricingSummary(db, organizationId, variantId);

  return (
    <main className={styles.container}>
      <header className={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <h1 style={{ margin: 0 }}>Tarification — {variant.name}</h1>
          {overview.activePlan ? (
            <span className={styles.statusBadgeActive}>
              ✓ Actif : {(overview.activePlan.priceAmountMinor / 100).toFixed(2)} € / jour
            </span>
          ) : overview.draftPlan ? (
            <span className={styles.statusBadgeDraft}>
              ● Brouillon : {(overview.draftPlan.priceAmountMinor / 100).toFixed(2)} € / jour
            </span>
          ) : (
            <span className={styles.statusBadgeNone}>Aucun tarif défini</span>
          )}
        </div>
        <p style={{ margin: 0, color: '#64748b' }}>
          Vélo : <strong>{details.product.name}</strong> • Catégorie : {details.category.name}
        </p>
      </header>

      {canManage ? (
        <PricingForm
          orgId={organizationId}
          productId={productId}
          variantId={variantId}
          overview={overview}
        />
      ) : (
        <div className={styles.card}>
          <p>Vous n’avez pas les droits nécessaires pour modifier les tarifs de ce produit.</p>
        </div>
      )}

      <p style={{ marginTop: '16px' }}>
        <Link
          href={`/dashboard/${organizationId}/catalog/${productId}/variants/${variantId}`}
          style={{ color: '#0284c7', textDecoration: 'none', fontWeight: 600 }}
        >
          ← Retour à la variante {variant.name}
        </Link>
      </p>
    </main>
  );
}
