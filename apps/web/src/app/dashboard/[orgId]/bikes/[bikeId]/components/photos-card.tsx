import type { UnifiedBike } from '@uttily/core';
import { PhotoCoachLauncher } from './photo-coach-launcher';
import styles from './components.module.css';

interface PhotosCardProps {
  organizationId: string;
  productId: string;
  photos: UnifiedBike['photos'];
}

export function BikePhotosCard({
  organizationId,
  productId,
  photos,
}: PhotosCardProps): React.ReactElement {
  return (
    <section className={styles.card} aria-labelledby="photos-title">
      <div className={styles.cardHeader}>
        <h2 id="photos-title" className={styles.cardTitle}>
          <span>📸</span> Standard Photo Coach (3 vues obligatoires)
        </h2>
        <div
          style={{
            fontSize: '0.88rem',
            fontWeight: 700,
            color: photos.isComplete ? '#059669' : '#d97706',
          }}
        >
          {photos.isComplete ? '✓ 3/3 photos conformes' : `${photos.count}/3 photos`}
        </div>
      </div>

      <p style={{ margin: 0, fontSize: '0.88rem', color: '#64748b' }}>
        Le Photo Coach guide vos prises de vue pour garantir la conformité au standard visuel de
        confiance.
      </p>

      <PhotoCoachLauncher
        organizationId={organizationId}
        productId={productId}
        photoItems={photos.items}
      />
    </section>
  );
}
