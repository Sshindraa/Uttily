import type { UnifiedBike } from '@uttily/core';
import { InventoryActions } from './inventory-actions';
import styles from './components.module.css';

interface InventoryCardProps {
  organizationId: string;
  variantId: string;
  inventory: UnifiedBike['inventory'];
  locations: Array<{ id: string; name: string }>;
}

export function BikeInventoryCard({
  organizationId,
  variantId,
  inventory,
  locations,
}: InventoryCardProps): React.ReactElement {
  return (
    <section className={styles.card} aria-labelledby="inventory-title">
      <div className={styles.cardHeader}>
        <h2 id="inventory-title" className={styles.cardTitle}>
          <span>🚲</span> Vélos en flotte
        </h2>
        <div className={styles.fleetSummary}>
          <span className={`${styles.fleetCountBadge} ${styles.fleetBadgeActive}`}>
            🟢 {inventory.activeCount} en service
          </span>
          {inventory.maintenanceCount > 0 && (
            <span className={`${styles.fleetCountBadge} ${styles.fleetBadgeMaintenance}`}>
              🟠 {inventory.maintenanceCount} maintenance
            </span>
          )}
          {inventory.retiredCount > 0 && (
            <span className={`${styles.fleetCountBadge} ${styles.fleetBadgeRetired}`}>
              ⚫ {inventory.retiredCount} retiré
            </span>
          )}
        </div>
      </div>

      <InventoryActions
        organizationId={organizationId}
        variantId={variantId}
        locations={locations}
        items={inventory.items}
      />
    </section>
  );
}
