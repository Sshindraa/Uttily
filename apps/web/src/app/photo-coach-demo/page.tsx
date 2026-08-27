'use client';

import { type ReactElement, useState } from 'react';
import { BIKE_PHOTO_SLOTS, type PhotoSlotType } from '@uttily/contracts';
import { PhotoCoachModal, PhotoProgress } from '@/components/photo-coach';
import type { ProductPhotoSummary } from '@uttily/core';
import styles from './page.module.css';

function SlotIcon({ slotType }: { slotType: PhotoSlotType }): ReactElement | null {
  switch (slotType) {
    case 'FULL_BIKE':
      return (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="5.5" cy="17.5" r="3.5" />
          <circle cx="18.5" cy="17.5" r="3.5" />
          <path d="M15 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm-3 11.5L8.5 8.5H15l2 4" />
          <path d="M12 17.5V14l-3.5-3" />
        </svg>
      );
    case 'DRIVETRAIN':
      return (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    case 'BRAKES_TIRES':
      return (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="3" />
          <path d="M12 3v3m0 12v3M3 12h3m12 0h3" strokeDasharray="2 2" />
        </svg>
      );
    case 'BATTERY':
      return (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <rect x="2" y="7" width="16" height="10" rx="2" ry="2" />
          <line x1="22" y1="11" x2="22" y2="13" />
          <path d="M10 9l-2 3h4l-2 3" strokeWidth="1.5" />
        </svg>
      );
    case 'MOTOR':
      return (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v8m-4-4h8" />
        </svg>
      );
    default:
      return null;
  }
}

export default function PhotoCoachDemoPage(): ReactElement {
  const [selectedSlot, setSelectedSlot] = useState<PhotoSlotType>('FULL_BIKE');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [mockPhotos, setMockPhotos] = useState<ProductPhotoSummary[]>([]);

  const hasFullBike = mockPhotos.some((p) => p.slotType === 'FULL_BIKE');
  const hasDrivetrain = mockPhotos.some((p) => p.slotType === 'DRIVETRAIN');
  const hasBrakesTires = mockPhotos.some((p) => p.slotType === 'BRAKES_TIRES');

  const nextSuggestedSlot: PhotoSlotType = !hasFullBike
    ? 'FULL_BIKE'
    : !hasDrivetrain
      ? 'DRIVETRAIN'
      : !hasBrakesTires
        ? 'BRAKES_TIRES'
        : 'FULL_BIKE';

  const handleOpenCoach = (slot: PhotoSlotType = nextSuggestedSlot) => {
    setSelectedSlot(slot);
    setIsModalOpen(true);
  };

  const handlePhotoUploaded = (photo: ProductPhotoSummary) => {
    setMockPhotos((prev) => [photo, ...prev]);
  };

  const availableSlots: PhotoSlotType[] = [
    'FULL_BIKE',
    'DRIVETRAIN',
    'BRAKES_TIRES',
    'BATTERY',
    'MOTOR',
  ];

  return (
    <main className={styles.container}>
      <div className={styles.wrapper}>
        <header className={styles.header}>
          <div className={styles.tagline}>Standard de confiance visuelle • Prise de vue guidée</div>
          <h1 className={styles.title}>Photo Coach Vélo Uttily</h1>
          <p className={styles.description}>
            Expérimentez le tunnel complet de prise de vue guidée : micro-animation d'exemple,
            viseur caméra avec Ghost Overlay SVG, checklist humaine active et enchaînement
            automatique.
          </p>
        </header>

        <section className={styles.card}>
          <PhotoProgress
            slots={{ hasFullBike, hasDrivetrain, hasBrakesTires }}
            totalRequiredSlots={3}
          />

          <div>
            <label
              style={{
                display: 'block',
                marginBottom: '12px',
                fontSize: '0.95rem',
                fontWeight: 600,
                color: '#cbd5e1',
              }}
            >
              Sélectionnez un cadrage à réaliser :
            </label>
            <div className={styles.slotSelector}>
              {availableSlots.map((slotKey) => {
                const slot = BIKE_PHOTO_SLOTS[slotKey];
                const isSelected = selectedSlot === slotKey;
                const isDone = mockPhotos.some((p) => p.slotType === slotKey);

                return (
                  <button
                    key={slotKey}
                    type="button"
                    className={`${styles.slotButton} ${isSelected ? styles.slotButtonActive : ''}`}
                    onClick={() => setSelectedSlot(slotKey)}
                  >
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}
                    >
                      <SlotIcon slotType={slotKey} />
                      <span style={{ fontWeight: 700 }}>
                        {isDone ? '✓ ' : ''}
                        {slot.title}
                      </span>
                    </div>
                    <span className={styles.slotDesc}>{slot.shortDescription}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.openCoachBtn}
              onClick={() => handleOpenCoach(selectedSlot)}
            >
              📸 Commencer la prise de vue guidée ({BIKE_PHOTO_SLOTS[selectedSlot].title})
            </button>
          </div>
        </section>

        {mockPhotos.length > 0 && (
          <section className={styles.capturedSection}>
            <h2 className={styles.capturedTitle}>
              Photos validées lors de cette session ({mockPhotos.length})
            </h2>
            <div className={styles.photosGrid}>
              {mockPhotos.map((photo) => (
                <div key={photo.id} className={styles.photoCard}>
                  <div className={styles.photoMeta}>
                    <span>
                      {photo.slotType ? BIKE_PHOTO_SLOTS[photo.slotType]?.title : 'Photo'}
                    </span>
                    <span className={styles.photoBadge}>Validée</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      <PhotoCoachModal
        orgId="1c13f5b8-cbc1-4c5c-a474-47f0a9d00172"
        productId="b5555acf-3f6a-4474-aa18-4d107993abbb"
        slotType={selectedSlot}
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onPhotoUploaded={handlePhotoUploaded}
      />
    </main>
  );
}
