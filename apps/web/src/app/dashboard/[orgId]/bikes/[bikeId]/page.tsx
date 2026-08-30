import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getUnifiedBike, listCategories, listLocations } from '@uttily/core';
import { requireCatalogViewerOf } from '@/lib/catalog-auth';
import { formatMoneyAmount } from '@/lib/status-presentation';
import { BikeIdentityCard } from './components/identity-card';
import { BikePhotosCard } from './components/photos-card';
import { BikePricingCard } from './components/pricing-card';
import { BikeInventoryCard } from './components/inventory-card';
import styles from './bike.module.css';

export default async function UnifiedBikePage({
  params,
}: {
  params: Promise<{ orgId: string; bikeId: string }>;
}): Promise<React.ReactElement> {
  const { orgId, bikeId } = await params;
  const { db, organizationId } = await requireCatalogViewerOf(orgId);

  const bike = await getUnifiedBike(db, organizationId, bikeId);
  if (bike === null) notFound();

  const [categoriesList, locationsList] = await Promise.all([
    listCategories(db),
    listLocations(db, organizationId),
  ]);

  const categories = categoriesList.map((c) => ({ id: c.id, name: c.name }));
  const locations = locationsList.map((l) => ({ id: l.id, name: l.name }));

  return (
    <div className={styles.container}>
      {/* Fil d'Ariane & Retour rapide */}
      <nav
        aria-label="Fil d’Ariane"
        style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.9rem' }}
      >
        <Link
          href={`/dashboard/${organizationId}/bikes`}
          style={{ color: '#0284c7', textDecoration: 'none', fontWeight: 700 }}
        >
          ← Retour à Mes équipements
        </Link>
        <span style={{ color: '#cbd5e1' }}>/</span>
        <span style={{ color: '#64748b' }}>{bike.product.name}</span>
      </nav>

      {/* Hero Header de l’équipement */}
      <section className={styles.heroCard} aria-labelledby="bike-heading">
        <div className={styles.heroTop}>
          <div className={styles.titleArea}>
            <div className={styles.metaRow}>
              <span className={styles.categoryTag}>{bike.product.categoryName}</span>
              <span>•</span>
              <span>
                Version : <strong>{bike.variant.name}</strong>
              </span>
            </div>
            <h1 id="bike-heading" className={styles.bikeTitle}>
              🧰 {bike.product.name}
            </h1>
          </div>

          <div>
            {bike.statusSummary === 'ONLINE_AVAILABLE' && (
              <span className={styles.statusBadgePublished}>🟢 En ligne · Disponible</span>
            )}
            {bike.statusSummary === 'ONLINE_UNAVAILABLE' && (
              <span
                className={styles.statusBadgeIncomplete}
                style={{ borderColor: '#fca5a5', color: '#dc2626', background: '#fef2f2' }}
              >
                🔴 En ligne · Indisponible (aucun exemplaire actif ou tarif manquant)
              </span>
            )}
            {bike.statusSummary === 'READY_TO_PUBLISH' && (
              <span className={styles.statusBadgeReady}>🔵 Prêt à publier</span>
            )}
            {bike.statusSummary === 'INCOMPLETE' && (
              <span className={styles.statusBadgeIncomplete}>⚪ Configuration incomplète</span>
            )}
            {bike.statusSummary === 'ARCHIVED' && (
              <span
                className={styles.statusBadgeIncomplete}
                style={{ color: '#64748b', background: '#f1f5f9' }}
              >
                ⚫ Archivé
              </span>
            )}
          </div>
        </div>

        {/* Barre de Synthèse Rapide */}
        <div className={styles.summaryBar}>
          <div className={styles.summaryItem}>
            <span style={{ color: bike.photos.isComplete ? '#10b981' : '#f59e0b' }}>
              {bike.photos.isComplete ? '✓' : '○'}
            </span>
            <span>{bike.photos.count}/3 vues requises</span>
          </div>

          <span className={styles.summaryDivider}>|</span>

          <div className={styles.summaryItem}>
            <span style={{ color: bike.pricing.isPriced ? '#10b981' : '#f59e0b' }}>
              {bike.pricing.isPriced ? '✓' : '○'}
            </span>
            <span>
              {bike.pricing.isPriced && bike.pricing.activePlan
                ? `${formatMoneyAmount(
                    bike.pricing.activePlan.priceAmountMinor,
                    bike.pricing.activePlan.currency,
                  )} / jour`
                : 'Tarif non configuré'}
            </span>
          </div>

          <span className={styles.summaryDivider}>|</span>

          <div className={styles.summaryItem}>
            <span style={{ color: bike.inventory.activeCount > 0 ? '#10b981' : '#f59e0b' }}>
              {bike.inventory.activeCount > 0 ? '✓' : '○'}
            </span>
            <span>{bike.inventory.activeCount} exemplaire(s) en service</span>
          </div>
        </div>
      </section>

      {/* Alerte si la fiche est incomplète */}
      {!bike.publication.ready && bike.publication.failures.length > 0 && (
        <section
          style={{
            background: '#fffbeb',
            border: '1px solid #fde68a',
            borderRadius: '16px',
            padding: '20px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
          aria-labelledby="failures-title"
        >
          <strong id="failures-title" style={{ color: '#92400e', fontSize: '1rem' }}>
            ⚠️ Éléments requis pour mettre cet équipement en ligne :
          </strong>
          <ul style={{ margin: 0, paddingLeft: '20px', color: '#b45309', fontSize: '0.92rem' }}>
            {bike.publication.failures.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </section>
      )}

      {/* 4 Piliers d'Action sur Place (V2 Centre de Commande) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <BikeIdentityCard
          organizationId={organizationId}
          product={bike.product}
          variant={bike.variant}
          categories={categories}
          isPublicationReady={bike.publication.ready}
        />

        <BikePhotosCard
          organizationId={organizationId}
          productId={bike.product.id}
          photos={bike.photos}
        />

        <BikePricingCard
          organizationId={organizationId}
          productId={bike.product.id}
          variantId={bike.variant.id}
          pricing={bike.pricing}
          currency={bike.variant.currency}
        />

        <BikeInventoryCard
          organizationId={organizationId}
          variantId={bike.variant.id}
          inventory={bike.inventory}
          locations={locations}
        />
      </div>
    </div>
  );
}
