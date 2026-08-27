'use client';

import { type ReactElement, useState } from 'react';
import { BIKE_PHOTO_SLOTS, type PhotoSlotType } from '@uttily/contracts';
import { PhotoCoachModal, PhotoProgress } from '@/components/photo-coach';
import type { ProductPhotoSummary } from '@uttily/core';
import styles from './page.module.css';

function SlotIcon({ slotType }: { slotType: PhotoSlotType }): ReactElement | null {
  switch (slotType) {
    case 'HERO_PROFILE':
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
    case 'THREE_QUARTER':
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
          <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
          <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
        </svg>
      );
    case 'SIGNATURE_DETAIL':
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
          <path d="M12 2v3m0 14v3M2 12h3m14 0h3" />
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
  const [selectedSlot, setSelectedSlot] = useState<PhotoSlotType>('HERO_PROFILE');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [mockPhotos, setMockPhotos] = useState<ProductPhotoSummary[]>([]);

  const hasHeroProfile = mockPhotos.some(
    (p) => p.slotType === 'HERO_PROFILE' || p.slotType === 'FULL_BIKE',
  );
  const hasThreeQuarter = mockPhotos.some(
    (p) => p.slotType === 'THREE_QUARTER' || p.slotType === 'DRIVETRAIN',
  );
  const hasSignatureDetail = mockPhotos.some(
    (p) => p.slotType === 'SIGNATURE_DETAIL' || p.slotType === 'BRAKES_TIRES',
  );

  const nextSuggestedSlot: PhotoSlotType = !hasHeroProfile
    ? 'HERO_PROFILE'
    : !hasThreeQuarter
      ? 'THREE_QUARTER'
      : !hasSignatureDetail
        ? 'SIGNATURE_DETAIL'
        : 'HERO_PROFILE';

  const handleOpenCoach = (slot: PhotoSlotType = nextSuggestedSlot) => {
    setSelectedSlot(slot);
    setIsModalOpen(true);
  };

  const handlePhotoUploaded = (photo: ProductPhotoSummary) => {
    setMockPhotos((prev) => [photo, ...prev]);
  };

  const availableSlots: PhotoSlotType[] = [
    'HERO_PROFILE',
    'THREE_QUARTER',
    'SIGNATURE_DETAIL',
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
            Expérimentez le tunnel de prise de vue guidée en 3 images e-commerce :
            <strong> Profil Hero</strong> (accroche), <strong>Vue 3/4</strong> (volume & dynamisme)
            et <strong>Détail Signature</strong> (praticité & atouts).
          </p>
        </header>

        <section className={styles.card}>
          <PhotoProgress
            slots={{ hasHeroProfile, hasThreeQuarter, hasSignatureDetail }}
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
