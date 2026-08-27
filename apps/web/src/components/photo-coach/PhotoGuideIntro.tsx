'use client';

import { type ReactElement, useEffect } from 'react';
import type { PhotoSlotDefinition } from '@uttily/contracts';
import { PhotoGuideAnimationAdapter } from './adapter';
import styles from './PhotoGuideIntro.module.css';

export interface PhotoGuideIntroProps {
  slot: PhotoSlotDefinition;
  onProceedToCamera: () => void;
}

export function PhotoGuideIntro({
  slot,
  onProceedToCamera,
}: PhotoGuideIntroProps): ReactElement {
  const OverlayComponent = PhotoGuideAnimationAdapter.resolveOverlay(slot.guide.overlayKey);

  // Transition automatique fluide vers le viseur après l'animation (fail-safe à 1800ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      onProceedToCamera();
    }, 1800);

    return () => clearTimeout(timer);
  }, [onProceedToCamera]);

  return (
    <div className={styles.container}>
      <div className={styles.stage} aria-label="Démonstration de cadrage vélo">
        <div className={styles.badgeAlert}>Trop près ✕</div>
        <div className={styles.badgeSuccess}>Cadrage attendu ✓</div>
        <div className={styles.guideFrame} />

        <div className={styles.bikeGraphic}>
          <OverlayComponent />
        </div>
      </div>

      <div className={styles.infoSection}>
        <h3 className={styles.title}>{slot.title}</h3>
        <p className={styles.hint}>{slot.guide.helperHint}</p>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={onProceedToCamera}
          >
            Prendre la photo
          </button>
          <button
            type="button"
            className={styles.skipBtn}
            onClick={onProceedToCamera}
          >
            Passer
          </button>
        </div>
      </div>
    </div>
  );
}
