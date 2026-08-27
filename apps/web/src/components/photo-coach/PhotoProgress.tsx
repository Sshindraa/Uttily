import type { ReactElement } from 'react';
import styles from './PhotoProgress.module.css';

export interface PhotoProgressProps {
  completedSlotsCount: number;
  totalRequiredSlots?: number;
}

export function PhotoProgress({
  completedSlotsCount,
  totalRequiredSlots = 3,
}: PhotoProgressProps): ReactElement {
  const hasFullBike = completedSlotsCount >= 1;
  const hasDrivetrain = completedSlotsCount >= 2;
  const hasBrakesTires = completedSlotsCount >= 3;

  return (
    <div className={styles.container} role="status" aria-label="Progression du standard photo">
      <svg
        viewBox="0 0 1000 600"
        className={styles.illustration}
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Slot 1 : Roues et cadre principal */}
        <g opacity={hasFullBike ? 1 : 0.2} strokeWidth="8">
          <circle cx="260" cy="400" r="115" />
          <circle cx="740" cy="400" r="115" />
          <line x1="260" y1="400" x2="470" y2="400" />
          <line x1="260" y1="400" x2="410" y2="240" />
          <line x1="470" y1="400" x2="410" y2="240" />
          <line x1="470" y1="400" x2="670" y2="230" />
          <line x1="410" y1="240" x2="670" y2="230" />
          <line x1="670" y1="230" x2="740" y2="400" />
          <path d="M670 230 L685 185 Q690 170 710 175" />
          <path d="M410 240 L395 190 M365 190 H435" />
        </g>

        {/* Slot 2 : Pédalier, chaîne et cassette */}
        <g opacity={hasDrivetrain ? 1 : 0.2} strokeWidth="6">
          <circle cx="470" cy="400" r="34" />
          <line x1="470" y1="400" x2="470" y2="455" />
          <rect x="455" y="455" width="30" height="7" rx="3" fill="currentColor" />
          <circle cx="260" cy="400" r="22" />
          <path d="M470 366 L260 378 M260 422 L470 434" strokeDasharray="8 4" />
        </g>

        {/* Slot 3 : Freins et détails pneus */}
        <g opacity={hasBrakesTires ? 1 : 0.2} strokeWidth="5">
          <path d="M720 330 Q725 340 730 350" />
          <path d="M295 305 Q290 315 285 325" />
          <circle cx="740" cy="400" r="125" strokeWidth="3" strokeDasharray="6 4" />
          <circle cx="260" cy="400" r="125" strokeWidth="3" strokeDasharray="6 4" />
        </g>
      </svg>

      <span className={styles.statusText}>
        Standard photo vélo : {completedSlotsCount}/{totalRequiredSlots} complétés
      </span>

      <div className={styles.stepIndicators}>
        {Array.from({ length: totalRequiredSlots }).map((_, i) => (
          <div
            key={i}
            className={`${styles.dot} ${
              i < completedSlotsCount
                ? styles.dotDone
                : i === completedSlotsCount
                ? styles.dotActive
                : ''
            }`}
          />
        ))}
      </div>
    </div>
  );
}
