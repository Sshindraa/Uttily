import Link from 'next/link';
import { listInventorySummaries, getMembership, CATALOG_MANAGERS } from '@uttily/core';
import { requireCatalogViewerOf } from '@/lib/catalog-auth';
import { OpenMaintenanceModal } from './open-maintenance-modal';
import styles from './fleet.module.css';

export default async function FleetListPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { db, organizationId, user } = await requireCatalogViewerOf((await params).orgId);
  const items = await listInventorySummaries(db, organizationId);
  const membership = await getMembership(db, organizationId, user.id);
  const canManage = membership !== null && CATALOG_MANAGERS.includes(membership.role);

  const availableCount = items.filter(
    (i) => i.status === 'ACTIVE' && i.condition !== 'BROKEN',
  ).length;
  const maintenanceCount = items.filter((i) => i.condition === 'BROKEN').length;

  const selectableItems = items.map((i) => ({
    id: i.id,
    internalSku: i.internalSku,
    productName: `${i.productName} (${i.variantName})`,
  }));

  return (
    <div className={styles.container}>
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.pageTitle}>🔧 Ma Flotte Physique</h1>
          <p className={styles.pageSubtitle}>
            Suivi unitaire de vos exemplaires physiques, états de service et maintenance.
          </p>
        </div>

        <div className={styles.headerActions}>
          <Link
            href={`/dashboard/${organizationId}/fleet/maintenance`}
            className={styles.workshopBtn}
          >
            🔧 Atelier ({maintenanceCount})
          </Link>

          {canManage && items.length > 0 && (
            <OpenMaintenanceModal orgId={organizationId} items={selectableItems} />
          )}

          {canManage && (
            <Link href={`/dashboard/${organizationId}/inventory/new`} className={styles.addBtn}>
              + Ajouter un exemplaire
            </Link>
          )}
        </div>
      </div>

      {/* Badges de synthèse rapide */}
      <div className={styles.statsRow}>
        <div className={styles.statCard}>
          <span className={styles.statValue}>{items.length}</span>
          <span className={styles.statLabel}>Exemplaires totaux</span>
        </div>
        <div className={styles.statCard}>
          <span className={`${styles.statValue} ${styles.statGreen}`}>{availableCount}</span>
          <span className={styles.statLabel}>En service · Disponibles</span>
        </div>
        <div className={styles.statCard}>
          <span className={`${styles.statValue} ${styles.statAmber}`}>{maintenanceCount}</span>
          <span className={styles.statLabel}>En maintenance / Révision</span>
        </div>
      </div>

      {items.length === 0 ? (
        <div className={styles.emptyState}>
          <span style={{ fontSize: '2.5rem' }}>🚲</span>
          <h3>Aucun exemplaire dans votre flotte</h3>
          <p>Ajoutez vos vélos physiques pour les rendre disponibles à la réservation.</p>
          {canManage && (
            <Link href={`/dashboard/${organizationId}/inventory/new`} className={styles.addBtn}>
              Ajouter mon premier exemplaire
            </Link>
          )}
        </div>
      ) : (
        <div className={styles.tableCard}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Code &amp; SKU</th>
                <th>Modèle / Variante</th>
                <th>N° de série</th>
                <th>État physique</th>
                <th>Statut</th>
                <th>Point de retrait</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const isBroken = item.condition === 'BROKEN';

                return (
                  <tr key={item.id}>
                    <td className={styles.skuCell}>
                      <Link href={`/dashboard/${organizationId}/inventory/${item.id}`}>
                        {item.internalSku}
                      </Link>
                    </td>
                    <td className={styles.modelCell}>
                      <strong>{item.productName}</strong>
                      <span className={styles.variantBadge}>{item.variantName}</span>
                    </td>
                    <td className={styles.serialCell}>{item.serialNumber ?? '—'}</td>
                    <td>
                      <span
                        className={`${styles.conditionBadge} ${
                          isBroken ? styles.conditionBroken : styles.conditionGood
                        }`}
                      >
                        {item.condition}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`${styles.statusBadge} ${
                          isBroken
                            ? styles.statusMaintenance
                            : item.status === 'ACTIVE'
                              ? styles.statusActive
                              : ''
                        }`}
                      >
                        {isBroken ? 'MAINTENANCE' : item.status}
                      </span>
                    </td>
                    <td className={styles.locationCell}>📍 {item.locationName}</td>
                    <td style={{ textAlign: 'right' }}>
                      <Link
                        href={`/dashboard/${organizationId}/inventory/${item.id}`}
                        className={styles.viewLink}
                      >
                        Détail →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
