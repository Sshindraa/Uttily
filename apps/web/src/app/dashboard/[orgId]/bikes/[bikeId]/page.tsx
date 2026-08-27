import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getUnifiedBike, getMembership, CATALOG_MANAGERS } from '@uttily/core';
import { requireCatalogViewerOf } from '@/lib/catalog-auth';
import styles from './bike.module.css';

export default async function UnifiedBikePage({
  params,
}: {
  params: Promise<{ orgId: string; bikeId: string }>;
}): Promise<React.ReactElement> {
  const { orgId, bikeId } = await params;
  const { db, organizationId, user } = await requireCatalogViewerOf(orgId);

  const bike = await getUnifiedBike(db, organizationId, bikeId);
  if (bike === null) notFound();

  const membership = await getMembership(db, organizationId, user.id);
  const canManage = membership !== null && CATALOG_MANAGERS.includes(membership.role);

  return (
    <div className={styles.container}>
      {/* Fil d'Ariane */}
      <nav aria-label="Fil d’Ariane" style={{ fontSize: '0.9rem', color: '#64748b' }}>
        <Link
          href={`/dashboard/${organizationId}`}
          style={{ color: '#0284c7', textDecoration: 'none' }}
        >
          Tableau de bord
        </Link>
        {' › '}
        <Link
          href={`/dashboard/${organizationId}/bikes`}
          style={{ color: '#0284c7', textDecoration: 'none' }}
        >
          Mes Vélos
        </Link>
        {' › '}
        <span style={{ color: '#1e293b', fontWeight: 600 }}>{bike.product.name}</span>
      </nav>

      {/* Hero Card du Vélo */}
      <section className={styles.heroCard} aria-labelledby="bike-heading">
        <div className={styles.heroTop}>
          <div className={styles.titleArea}>
            <div className={styles.metaRow}>
              <span className={styles.categoryTag}>{bike.product.categoryName}</span>
              <span>•</span>
              <span>
                Variante : <strong>{bike.variant.name}</strong>
              </span>
            </div>
            <h1 id="bike-heading" className={styles.bikeTitle}>
              🚲 {bike.product.name}
            </h1>
          </div>

          <div>
            {bike.readiness.statusSummary === 'BOOKABLE' && (
              <span className={styles.statusBadgePublished}>🟢 En ligne & Réservable</span>
            )}
            {bike.readiness.statusSummary === 'PUBLISHED_UNAVAILABLE' && (
              <span
                className={styles.statusBadgeIncomplete}
                style={{ borderColor: '#fca5a5', color: '#dc2626', background: '#fef2f2' }}
              >
                🔴 En ligne (Indisponible)
              </span>
            )}
            {bike.readiness.statusSummary === 'READY_TO_PUBLISH' && (
              <span className={styles.statusBadgeReady}>🔵 Prêt à être publié</span>
            )}
            {bike.readiness.statusSummary === 'INCOMPLETE' && (
              <span className={styles.statusBadgeIncomplete}>⚪ Configuration incomplète</span>
            )}
            {bike.readiness.statusSummary === 'ARCHIVED' && (
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
            <span>{bike.photos.count}/3 photos valides</span>
          </div>

          <span className={styles.summaryDivider}>|</span>

          <div className={styles.summaryItem}>
            <span style={{ color: bike.pricing.isPriced ? '#10b981' : '#f59e0b' }}>
              {bike.pricing.isPriced ? '✓' : '○'}
            </span>
            <span>
              {bike.pricing.activePlan
                ? `${(bike.pricing.activePlan.priceAmountMinor / 100).toFixed(2)} € / jour`
                : 'Aucun tarif actif'}
            </span>
          </div>

          <span className={styles.summaryDivider}>|</span>

          <div className={styles.summaryItem}>
            <span style={{ color: bike.inventory.activeCount >= 1 ? '#10b981' : '#f59e0b' }}>
              {bike.inventory.activeCount >= 1 ? '✓' : '○'}
            </span>
            <span>{bike.inventory.activeCount} vélo(s) disponible(s)</span>
          </div>
        </div>
      </section>

      {/* Grille des 4 Piliers Unifiés */}
      <div className={styles.pillarsGrid}>
        {/* Pilier 1 : Identité & Modèle */}
        <section className={styles.pillarCard} aria-labelledby="pillar-identity-heading">
          <div className={styles.pillarHeader}>
            <h2 id="pillar-identity-heading" className={styles.pillarTitle}>
              📝 1. Identité & Descriptif
            </h2>
            {canManage && (
              <Link
                href={`/dashboard/${organizationId}/catalog/${bike.product.id}/edit`}
                className={styles.pillarActionLink}
              >
                Modifier →
              </Link>
            )}
          </div>

          <div>
            <p style={{ margin: '0 0 12px 0', fontSize: '0.95rem', color: '#334155' }}>
              {bike.product.description || (
                <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>
                  Aucune description renseignée.
                </span>
              )}
            </p>
            <div style={{ fontSize: '0.85rem', color: '#64748b', display: 'flex', gap: '16px' }}>
              <span>
                Catégorie : <strong>{bike.product.categoryName}</strong>
              </span>
              <span>
                Taille / Variante : <strong>{bike.variant.name}</strong>
              </span>
            </div>
          </div>
        </section>

        {/* Pilier 2 : Standard Photo (Photo Coach) */}
        <section className={styles.pillarCard} aria-labelledby="pillar-photos-heading">
          <div className={styles.pillarHeader}>
            <h2 id="pillar-photos-heading" className={styles.pillarTitle}>
              📸 2. Standard Photo (3 Vues)
            </h2>
            {canManage && (
              <Link
                href={`/dashboard/${organizationId}/catalog/${bike.product.id}`}
                className={styles.pillarActionLink}
              >
                Gérer les photos →
              </Link>
            )}
          </div>

          <div className={styles.photosGrid}>
            <div
              className={`${styles.photoThumbnail} ${bike.photos.count >= 1 ? styles.photoThumbnailFilled : ''}`}
            >
              <span>{bike.photos.count >= 1 ? '✓ Profil Hero' : '○ Profil Hero'}</span>
            </div>
            <div
              className={`${styles.photoThumbnail} ${bike.photos.count >= 2 ? styles.photoThumbnailFilled : ''}`}
            >
              <span>{bike.photos.count >= 2 ? '✓ 3/4 Avant' : '○ 3/4 Avant'}</span>
            </div>
            <div
              className={`${styles.photoThumbnail} ${bike.photos.count >= 3 ? styles.photoThumbnailFilled : ''}`}
            >
              <span>{bike.photos.count >= 3 ? '✓ Vue Libre' : '○ Vue Libre'}</span>
            </div>
          </div>
        </section>

        {/* Pilier 3 : Tarification Journalière */}
        <section className={styles.pillarCard} aria-labelledby="pillar-pricing-heading">
          <div className={styles.pillarHeader}>
            <h2 id="pillar-pricing-heading" className={styles.pillarTitle}>
              🏷️ 3. Tarification & Paliers
            </h2>
            {canManage && (
              <Link
                href={`/dashboard/${organizationId}/catalog/${bike.product.id}/variants/${bike.variant.id}/pricing`}
                className={styles.pillarActionLink}
              >
                {bike.pricing.activePlan ? 'Modifier le tarif →' : 'Définir le tarif →'}
              </Link>
            )}
          </div>

          {bike.pricing.activePlan ? (
            <div>
              <div className={styles.priceBigRow}>
                <span className={styles.priceAmount}>
                  {(bike.pricing.activePlan.priceAmountMinor / 100).toFixed(2)} €
                </span>
                <span className={styles.priceUnit}>/ jour (TTC)</span>
              </div>

              {bike.pricing.activePlan.discountTiers.length > 0 && (
                <div className={styles.tiersList} style={{ marginTop: '12px' }}>
                  <span style={{ fontWeight: 700, fontSize: '0.85rem', color: '#64748b' }}>
                    Tarifs dégressifs actifs :
                  </span>
                  {bike.pricing.activePlan.discountTiers.map((t) => (
                    <div key={t.thresholdDays}>
                      • Dès {t.thresholdDays} jours : <strong>−{t.discountPercent} %</strong> (
                      {(
                        ((bike.pricing.activePlan!.priceAmountMinor / 100) *
                          (100 - t.discountPercent)) /
                        100
                      ).toFixed(2)}{' '}
                      €/j)
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div style={{ color: '#64748b', fontSize: '0.9rem' }}>
              Aucun tarif actif. Cliquez ci-dessus pour définir le prix à la journée.
            </div>
          )}
        </section>

        {/* Pilier 4 : Flotte Physique & Exemplaires */}
        <section className={styles.pillarCard} aria-labelledby="pillar-inventory-heading">
          <div className={styles.pillarHeader}>
            <h2 id="pillar-inventory-heading" className={styles.pillarTitle}>
              🔢 4. Flotte & Numéros de Série
            </h2>
            {canManage && (
              <Link
                href={`/dashboard/${organizationId}/inventory/new`}
                className={styles.pillarActionLink}
              >
                + Ajouter des vélos →
              </Link>
            )}
          </div>

          <div className={styles.inventoryCountRow}>
            <div className={styles.countBadge}>{bike.inventory.activeCount}</div>
            <div style={{ fontSize: '0.9rem', color: '#475569' }}>
              <strong>vélo(s) en service</strong> prêt(s) à rouler et allouables sans risque de
              surbooking.
            </div>
          </div>

          {bike.inventory.items.length > 0 && (
            <ul className={styles.itemsList}>
              {bike.inventory.items.slice(0, 3).map((item) => (
                <li key={item.id} className={styles.itemRow}>
                  <span>
                    <strong>
                      {item.serialNumber ? `N° ${item.serialNumber}` : (item.sku ?? 'Exemplaire')}
                    </strong>
                  </span>
                  <span
                    style={{
                      color: item.status === 'ACTIVE' ? '#059669' : '#d97706',
                      fontWeight: 600,
                    }}
                  >
                    {item.status === 'ACTIVE' ? 'Prêt à rouler' : item.status}
                  </span>
                </li>
              ))}
              {bike.inventory.items.length > 3 && (
                <li style={{ fontSize: '0.8rem', color: '#64748b', textAlign: 'center' }}>
                  + {bike.inventory.items.length - 3} autre(s) vélo(s)
                </li>
              )}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
