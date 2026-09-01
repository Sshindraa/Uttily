import Link from 'next/link';
import type { UnifiedBike } from '@uttily/core';
import {
  formatMoneyAmount,
  getPricingPlanTypeLabel,
  getPricingPlanUnitLabel,
} from '@/lib/status-presentation';
import { BikeIdentityCard } from './components/identity-card';
import { BikePhotosCard } from './components/photos-card';
import { BikePricingCard } from './components/pricing-card';
import { BikeInventoryCard } from './components/inventory-card';
import styles from './bike-detail.module.css';

export interface BikeDetailViewProps {
  organizationId: string;
  bike: UnifiedBike;
  categories: Array<{ id: string; name: string }>;
  locations: Array<{ id: string; name: string }>;
}

export function BikeDetailView({
  organizationId,
  bike,
  categories,
  locations,
}: BikeDetailViewProps): React.ReactElement {
  return (
    <div className={styles.container}>
      {/* Fil d'Ariane & Retour rapide */}
      <nav
        aria-label="Fil d’Ariane"
        style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.9rem' }}
      >
        <Link
          href={`/dashboard/${organizationId}/bikes`}
          style={{
            color: 'var(--ut-color-primary)',
            textDecoration: 'none',
            fontWeight: 'var(--ut-weight-bold)',
          }}
        >
          ← Retour à Mes équipements
        </Link>
        <span style={{ color: 'var(--ut-color-border-strong)' }}>/</span>
        <span style={{ color: 'var(--ut-color-ink-muted)' }}>{bike.product.name}</span>
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
                style={{
                  borderColor: 'var(--ut-color-danger-soft)',
                  color: 'var(--ut-color-danger)',
                  background: 'var(--ut-color-danger-soft)',
                }}
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
                style={{
                  color: 'var(--ut-color-ink-muted)',
                  background: 'var(--ut-color-surface-soft)',
                }}
              >
                ⚫ Archivé
              </span>
            )}
          </div>
        </div>

        {/* Barre de Synthèse Rapide */}
        <div className={styles.summaryBar}>
          <div className={styles.summaryItem}>
            <span
              style={{
                color: bike.photos.isComplete
                  ? 'var(--ut-color-success)'
                  : 'var(--ut-color-warning)',
              }}
            >
              {bike.photos.isComplete ? '✓' : '○'}
            </span>
            <span>{bike.photos.count}/3 vues requises</span>
          </div>

          <span className={styles.summaryDivider}>|</span>

          <div className={styles.summaryItem}>
            <span
              style={{
                color: bike.pricing.isPriced
                  ? 'var(--ut-color-success)'
                  : 'var(--ut-color-warning)',
              }}
            >
              {bike.pricing.isPriced ? '✓' : '○'}
            </span>
            <span>
              {bike.pricing.isPriced && bike.pricing.activePlan
                ? `${getPricingPlanTypeLabel(bike.pricing.activePlan.planType)} : ${formatMoneyAmount(
                    bike.pricing.activePlan.priceAmountMinor,
                    bike.pricing.activePlan.currency,
                  )} ${getPricingPlanUnitLabel(bike.pricing.activePlan.planType)}`
                : 'Tarif non configuré'}
            </span>
          </div>

          <span className={styles.summaryDivider}>|</span>

          <div className={styles.summaryItem}>
            <span
              style={{
                color:
                  bike.inventory.activeCount > 0
                    ? 'var(--ut-color-success)'
                    : 'var(--ut-color-warning)',
              }}
            >
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
            background: 'var(--ut-color-surface)beb',
            border: '1px solid var(--ut-color-warning-soft)',
            borderRadius: '16px',
            padding: '20px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
          aria-labelledby="failures-title"
        >
          <strong
            id="failures-title"
            style={{ color: 'var(--ut-color-warning)', fontSize: '1rem' }}
          >
            ⚠️ Éléments requis pour mettre cet équipement en ligne :
          </strong>
          <ul
            style={{
              margin: 0,
              paddingLeft: '20px',
              color: 'var(--ut-color-warning)',
              fontSize: '0.92rem',
            }}
          >
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
