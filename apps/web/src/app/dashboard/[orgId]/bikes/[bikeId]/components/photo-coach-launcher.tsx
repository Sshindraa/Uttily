'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PhotoSlotType } from '@uttily/contracts';
import type { UnifiedBikePhotoItem } from '@uttily/core';
import { PhotoCoachModal } from '@/components/photo-coach/PhotoCoachModal';
import styles from './components.module.css';

interface PhotoCoachLauncherProps {
  organizationId: string;
  productId: string;
  photoItems: UnifiedBikePhotoItem[];
}

const SLOTS_CONFIG: Array<{
  slotType: PhotoSlotType;
  title: string;
  subtitle: string;
  icon: string;
}> = [
  {
    slotType: 'HERO_PROFILE',
    title: 'Profil latéral Hero',
    subtitle: 'Vue complète, côté transmission',
    icon: '🚲',
  },
  {
    slotType: 'THREE_QUARTER_FRONT',
    title: '3/4 Avant dynamique',
    subtitle: 'Guidon tourné, perspective valorisante',
    icon: '📐',
  },
  {
    slotType: 'SECONDARY_VIEW',
    title: 'Vue libre valorisante',
    subtitle: 'Transmission, poste de pilotage ou accessoire',
    icon: '✨',
  },
];

export function PhotoCoachLauncher({
  organizationId,
  productId,
  photoItems,
}: PhotoCoachLauncherProps): React.ReactElement {
  const router = useRouter();
  const [activeSlot, setActiveSlot] = useState<PhotoSlotType | null>(null);

  const getSlotPhoto = (type: PhotoSlotType): UnifiedBikePhotoItem | undefined => {
    return photoItems.find((photo) => photo.slotKey === type);
  };

  return (
    <>
      <div className={styles.photosGrid}>
        {SLOTS_CONFIG.map((config) => {
          const photo = getSlotPhoto(config.slotType);

          return (
            <div
              key={config.slotType}
              onClick={() => setActiveSlot(config.slotType)}
              className={`${styles.photoSlotCard} ${photo ? styles.photoSlotCardFilled : ''}`}
            >
              {photo ? (
                <>
                  <img
                    src={`/api/public/product-photos/${photo.publicId}`}
                    alt={config.title}
                    className={styles.photoSlotThumbnail}
                  />
                  <div className={styles.photoSlotLabel}>{config.title}</div>
                  <div className={styles.photoSlotStatus} style={{ color: '#059669' }}>
                    ✓ Photo conforme
                  </div>
                  <button
                    type="button"
                    className={styles.actionBtn}
                    style={{ fontSize: '0.78rem', padding: '4px 8px', marginTop: '4px' }}
                  >
                    Remplacer
                  </button>
                </>
              ) : (
                <>
                  <div style={{ fontSize: '2rem' }}>{config.icon}</div>
                  <div className={styles.photoSlotLabel}>{config.title}</div>
                  <div style={{ fontSize: '0.8rem', color: '#64748b' }}>{config.subtitle}</div>
                  <button
                    type="button"
                    className={`${styles.actionBtn} ${styles.actionBtnPrimary}`}
                    style={{ fontSize: '0.82rem', marginTop: '6px' }}
                  >
                    + Prendre la photo
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {activeSlot && (
        <PhotoCoachModal
          orgId={organizationId}
          productId={productId}
          slotType={activeSlot}
          isOpen={true}
          onClose={() => setActiveSlot(null)}
          onPhotoUploaded={() => {
            setActiveSlot(null);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
