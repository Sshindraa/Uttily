import type { ReactElement } from 'react';
import styles from './PhotoProgress.module.css';

export interface PhotoProgressProps {
  completedSlotsCount?: number | undefined;
  slots?:
    | {
        hasHeroProfile?: boolean | undefined;
        hasThreeQuarterFront?: boolean | undefined;
        hasSecondaryView?: boolean | undefined;
        hasThreeQuarter?: boolean | undefined;
        hasSignatureDetail?: boolean | undefined;
        hasFullBike?: boolean | undefined;
        hasDrivetrain?: boolean | undefined;
        hasBrakesTires?: boolean | undefined;
      }
    | undefined;
  totalRequiredSlots?: number | undefined;
}

export function PhotoProgress({
  completedSlotsCount,
  slots,
  totalRequiredSlots = 3,
}: PhotoProgressProps): ReactElement {
  const hasHero = slots
    ? !!(slots.hasHeroProfile || slots.hasFullBike)
    : (completedSlotsCount ?? 0) >= 1;
  const hasThreeQ = slots
    ? !!(slots.hasThreeQuarterFront || slots.hasThreeQuarter || slots.hasDrivetrain)
    : (completedSlotsCount ?? 0) >= 2;
  const hasSecondary = slots
    ? !!(slots.hasSecondaryView || slots.hasSignatureDetail || slots.hasBrakesTires)
    : (completedSlotsCount ?? 0) >= 3;

  const actualCompletedCount = slots
    ? (hasHero ? 1 : 0) + (hasThreeQ ? 1 : 0) + (hasSecondary ? 1 : 0)
    : (completedSlotsCount ?? 0);

  return (
    <div className={styles.container} role="status" aria-label="Progression du standard photo">
      <div className={styles.illustrationWrapper}>
        <svg
          viewBox="100 50 660 310"
          className={styles.illustration}
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {/* Repères optiques HUD : 4 coins de visée de cadrage caméra */}
          <g stroke="currentColor" strokeWidth="2.5" opacity="0.4">
            <path d="M120 80 H145 M120 80 V105" />
            <path d="M740 80 H715 M740 80 V105" />
            <path d="M120 330 H145 M120 330 V305" />
            <path d="M740 330 H715 M740 330 V305" />
          </g>

          {/* Ligne de sol / horizon d'alignement */}
          <line
            x1="130"
            y1="325"
            x2="730"
            y2="325"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="4 8"
            opacity="0.25"
          />

          {/* Axe de centrage optique vertical et horizontal */}
          <g stroke="currentColor" strokeWidth="1" opacity="0.2">
            <line x1="430" y1="65" x2="430" y2="85" />
            <line x1="430" y1="325" x2="430" y2="345" />
            <circle cx="430" cy="205" r="3" fill="currentColor" opacity="0.4" />
          </g>

          {/* Slot 1 : Vue de profil (roues pleines de profil et géométrie cadre) */}
          <g opacity={hasHero ? 1 : 0.28} strokeWidth={hasHero ? '4' : '3'}>
            {/* Roue arrière */}
            <circle cx="270" cy="265" r="58" />
            <circle cx="270" cy="265" r="48" strokeDasharray="3 4" strokeWidth="1.5" />
            <circle cx="270" cy="265" r="8" fill="currentColor" />

            {/* Roue avant */}
            <circle cx="590" cy="265" r="58" />
            <circle cx="590" cy="265" r="48" strokeDasharray="3 4" strokeWidth="1.5" />
            <circle cx="590" cy="265" r="8" fill="currentColor" />

            {/* Cadre principal */}
            <line x1="270" y1="265" x2="415" y2="265" /> {/* Base arrière */}
            <line x1="270" y1="265" x2="380" y2="155" /> {/* Hauban */}
            <line x1="415" y1="265" x2="380" y2="155" /> {/* Tube de selle */}
            <line x1="415" y1="265" x2="540" y2="145" /> {/* Tube diagonal */}
            <line x1="380" y1="155" x2="540" y2="145" /> {/* Tube supérieur */}
            <line x1="540" y1="145" x2="590" y2="265" /> {/* Fourche avant */}

            {/* Selle */}
            <path d="M380 155 L375 125 M345 122 H405" strokeWidth="4" />

            {/* Cintre / Potence de profil */}
            <path d="M540 145 L548 112 Q550 102 568 106" strokeWidth="4" />
          </g>

          {/* Slot 2 : Vue 3/4 avant (volume cockpit et transmission) */}
          <g opacity={hasThreeQ ? 1 : 0.25} strokeWidth="3">
            {/* Pédalier et manivelles */}
            <circle cx="415" cy="265" r="18" strokeWidth="2.5" />
            <line x1="415" y1="265" x2="415" y2="295" strokeWidth="3" />
            <rect x="403" y="295" width="24" height="6" rx="2" fill="currentColor" />

            {/* Chaîne */}
            <path d="M415 247 L270 255 M270 275 L415 283" strokeDasharray="5 3" strokeWidth="1.8" />

            {/* Repère de perspective 3/4 cockpit */}
            <path d="M536 112 L568 104 M536 112 L518 118" strokeWidth="3" />
          </g>

          {/* Slot 3 : Vue libre valorisante (faisceau de détail signature & accessoires) */}
          <g opacity={hasSecondary ? 1 : 0.2} strokeWidth="2.5">
            {/* Cible de détail signature sur le porte-bagages / selle */}
            <circle cx="340" cy="180" r="24" strokeWidth="2" strokeDasharray="5 3" />
            <circle cx="340" cy="180" r="4" fill="currentColor" />

            {/* Rayonnement indicateur de valorisation */}
            <path d="M340 146 V152 M340 208 V214 M306 180 H312 M368 180 H374" strokeWidth="2" />
          </g>
        </svg>
      </div>

      <span className={styles.statusText}>
        {actualCompletedCount} sur {totalRequiredSlots} photos validées
      </span>

      <div className={styles.stepIndicators}>
        {Array.from({ length: totalRequiredSlots }).map((_, i) => (
          <div
            key={i}
            className={`${styles.dot} ${
              i < actualCompletedCount
                ? styles.dotDone
                : i === actualCompletedCount
                  ? styles.dotActive
                  : ''
            }`}
          />
        ))}
      </div>
    </div>
  );
}
