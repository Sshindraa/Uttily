import Link from 'next/link';
import {
  listUnifiedBikes,
  getMembership,
  CATALOG_MANAGERS,
  type UnifiedBikeStatusSummary,
} from '@uttily/core';
import { requireCatalogViewerOf } from '@/lib/catalog-auth';
import styles from './bikes-list.module.css';

function renderStatusBadge(status: UnifiedBikeStatusSummary): React.ReactElement {
  switch (status) {
    case 'BOOKABLE':
      return <span className={styles.statusBadgeBookable}>🟢 En ligne & réservable</span>;
    case 'PUBLISHED_UNAVAILABLE':
      return <span className={styles.statusBadgeUnavailable}>🔴 En ligne (Indisponible)</span>;
    case 'READY_TO_PUBLISH':
      return <span className={styles.statusBadgeReady}>🔵 Prêt à publier</span>;
    case 'INCOMPLETE':
      return <span className={styles.statusBadgeIncomplete}>⚪ Brouillon incomplet</span>;
    case 'ARCHIVED':
      return <span className={styles.statusBadgeArchived}>⚫ Archivé</span>;
  }
}

export default async function BikesListPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const { db, organizationId, user } = await requireCatalogViewerOf(orgId);

  const bikes = await listUnifiedBikes(db, organizationId);
  const membership = await getMembership(db, organizationId, user.id);
  const canManage = membership !== null && CATALOG_MANAGERS.includes(membership.role);

  const totalActiveFleet = bikes.reduce((acc, b) => acc + b.activeInventoryCount, 0);

  return (
    <div className={styles.container}>
      <div className={styles.headerRow}>
        <div className={styles.titleArea}>
          <h1 className={styles.pageTitle}>🚲 Mes Vélos</h1>
          <p className={styles.pageSubtitle}>
            {bikes.length} modèle(s) au catalogue • {totalActiveFleet} vélo(s) en service
          </p>
        </div>

        {canManage && (
          <Link href={`/dashboard/${organizationId}/catalog/new`} className={styles.addBikeBtn}>
            <span>+</span> Ajouter un vélo
          </Link>
        )}
      </div>

      {bikes.length === 0 ? (
        <section className={styles.emptyState} aria-labelledby="empty-bikes-heading">
          <div style={{ fontSize: '2.5rem' }}>🚲</div>
          <h2 id="empty-bikes-heading" style={{ margin: 0, fontSize: '1.25rem', color: '#0f172a' }}>
            Aucun vélo pour le moment
          </h2>
          <p style={{ margin: 0, color: '#64748b', fontSize: '0.95rem', maxWidth: '400px' }}>
            Ajoutez votre premier modèle pour définir ses photos, son tarif journalier et vos
            exemplaires disponibles.
          </p>
          {canManage && (
            <Link
              href={`/dashboard/${organizationId}/catalog/new`}
              className={styles.addBikeBtn}
              style={{ marginTop: '8px' }}
            >
              Ajouter mon premier vélo →
            </Link>
          )}
        </section>
      ) : (
        <div className={styles.bikesGrid}>
          {bikes.map((bike) => {
            const isReadyOrBookable =
              bike.statusSummary === 'BOOKABLE' || bike.statusSummary === 'READY_TO_PUBLISH';

            return (
              <article
                key={bike.id}
                className={styles.bikeCard}
                aria-labelledby={`bike-title-${bike.id}`}
              >
                <div className={styles.cardTop}>
                  <div className={styles.cardHeader}>
                    <div>
                      <h2 id={`bike-title-${bike.id}`} className={styles.bikeName}>
                        {bike.name}
                      </h2>
                      <div className={styles.bikeMeta}>
                        {bike.categoryName} • {bike.variantName}
                      </div>
                    </div>
                    {renderStatusBadge(bike.statusSummary)}
                  </div>

                  <div className={styles.cardSummary}>
                    <div className={styles.summaryRow}>
                      <span className={styles.summaryKey}>Photos (3 vues)</span>
                      <span className={styles.summaryVal}>
                        {bike.hasRequiredPhotos ? '✓' : '○'} {bike.photoCount}/3 validées
                      </span>
                    </div>

                    <div className={styles.summaryRow}>
                      <span className={styles.summaryKey}>Prix / jour</span>
                      <span className={styles.summaryVal}>
                        {bike.priceAmountMinor !== null
                          ? `${(bike.priceAmountMinor / 100).toFixed(2)} €`
                          : '○ Non configuré'}
                      </span>
                    </div>

                    <div className={styles.summaryRow}>
                      <span className={styles.summaryKey}>Flotte disponible</span>
                      <span className={styles.summaryVal}>
                        {bike.activeInventoryCount >= 1 ? '✓' : '○'} {bike.activeInventoryCount}{' '}
                        vélo(s)
                      </span>
                    </div>
                  </div>
                </div>

                <Link
                  href={`/dashboard/${organizationId}/bikes/${bike.id}`}
                  className={styles.cardActionLink}
                >
                  {isReadyOrBookable ? 'Gérer le vélo →' : 'Terminer la configuration →'}
                </Link>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
