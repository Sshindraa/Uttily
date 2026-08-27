'use client';

import { type ReactElement, useState } from 'react';
import { BIKE_PHOTO_SLOTS, type PhotoSlotType } from '@uttily/contracts';
import { PhotoCoachModal, PhotoProgress } from '@/components/photo-coach';
import type { ProductPhotoSummary } from '@uttily/core';
import styles from './page.module.css';

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
          <div className={styles.tagline}>G8B-3 • Visual Trust & Assisted Onboarding</div>
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
                marginBottom: '8px',
                fontSize: '0.9rem',
                color: '#94a3b8',
              }}
            >
              Sélectionnez un slot à tester :
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
                    <span>
                      {isDone ? '✓ ' : ''}
                      {slot.title}
                    </span>
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
              📸 Tester le Photo Coach ({BIKE_PHOTO_SLOTS[selectedSlot].title})
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
