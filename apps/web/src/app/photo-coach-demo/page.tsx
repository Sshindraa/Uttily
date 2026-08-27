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
    case 'THREE_QUARTER_FRONT':
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
    case 'SECONDARY_VIEW':
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
    default:
      return null;
  }
}

function SlotSilhouette({ slotType }: { slotType: PhotoSlotType }): ReactElement {
  switch (slotType) {
    case 'HERO_PROFILE':
      return (
        <svg
          viewBox="0 0 160 80"
          width="100%"
          height="100%"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="35" cy="55" r="18" />
          <circle cx="125" cy="55" r="18" />
          <path d="M35 55 L70 55 L60 30 L35 55" />
          <path d="M70 55 L100 28 L60 30" />
          <path d="M100 28 L125 55" />
          <path d="M100 28 L104 18 Q106 14 114 16" strokeWidth="3" />
          <path d="M60 30 L57 20 M50 20 H64" strokeWidth="3" />
        </svg>
      );
    case 'THREE_QUARTER_FRONT':
      return (
        <svg
          viewBox="0 0 160 80"
          width="100%"
          height="100%"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <ellipse cx="118" cy="54" rx="14" ry="20" transform="rotate(-8 118 54)" strokeWidth="3" />
          <ellipse cx="42" cy="46" rx="10" ry="14" transform="rotate(-6 42 46)" />
          <path d="M42 46 L75 52 L66 32 L42 46" />
          <path d="M75 52 L106 28 L66 32" />
          <path d="M106 28 L118 54" strokeWidth="3" />
          <path d="M106 28 L109 18 M98 17 Q109 19 122 17" strokeWidth="3.5" />
          <path d="M66 32 L64 24 M58 24 H70" />
        </svg>
      );
    case 'SECONDARY_VIEW':
    default:
      return (
        <svg
          viewBox="0 0 160 80"
          width="100%"
          height="100%"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="80" cy="40" r="20" strokeDasharray="6 4" strokeWidth="2.5" />
          <circle cx="80" cy="40" r="3" fill="currentColor" />
          <path d="M58 24 H50 V32" strokeWidth="3" />
          <path d="M102 24 H110 V32" strokeWidth="3" />
          <path d="M58 56 H50 V48" strokeWidth="3" />
          <path d="M102 56 H110 V48" strokeWidth="3" />
          <circle cx="80" cy="40" r="10" strokeWidth="2" opacity="0.6" />
        </svg>
      );
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
    (p) =>
      p.slotType === 'THREE_QUARTER_FRONT' ||
      p.slotType === 'THREE_QUARTER' ||
      p.slotType === 'DRIVETRAIN',
  );
  const hasSecondaryView = mockPhotos.some(
    (p) =>
      p.slotType === 'SECONDARY_VIEW' ||
      p.slotType === 'SIGNATURE_DETAIL' ||
      p.slotType === 'BRAKES_TIRES',
  );

  const nextSuggestedSlot: PhotoSlotType = !hasHeroProfile
    ? 'HERO_PROFILE'
    : !hasThreeQuarter
      ? 'THREE_QUARTER_FRONT'
      : !hasSecondaryView
        ? 'SECONDARY_VIEW'
        : 'HERO_PROFILE';

  const handleOpenCoach = (slot: PhotoSlotType = nextSuggestedSlot) => {
    setSelectedSlot(slot);
    setIsModalOpen(true);
  };

  const handlePhotoUploaded = (photo: ProductPhotoSummary) => {
    setMockPhotos((prev) => [photo, ...prev]);
  };

  const availableSlots: PhotoSlotType[] = ['HERO_PROFILE', 'THREE_QUARTER_FRONT', 'SECONDARY_VIEW'];

  const getCtaLabel = (slot: PhotoSlotType): string => {
    if (slot === 'HERO_PROFILE') return '📸 Commencer par la vue profil';
    if (slot === 'THREE_QUARTER_FRONT') return '📸 Continuer avec la vue 3/4 avant';
    return '📸 Compléter avec le détail ou angle libre';
  };

  return (
    <main className={styles.container}>
      <div className={styles.wrapper}>
        <header className={styles.header}>
          <div className={styles.tagline}>Standard de confiance visuelle • Prise de vue guidée</div>
          <h1 className={styles.title}>Photo Coach Vélo Uttily</h1>
          <p className={styles.description}>
            3 photos suffisent pour présenter votre vélo sous son meilleur angle.
          </p>
        </header>

        <section className={styles.card}>
          <PhotoProgress
            slots={{
              hasHeroProfile,
              hasThreeQuarterFront: hasThreeQuarter,
              hasSecondaryView,
            }}
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
                    <div className={styles.slotIllustrationBox}>
                      <SlotSilhouette slotType={slotKey} />
                    </div>
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
              {getCtaLabel(selectedSlot)}
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
