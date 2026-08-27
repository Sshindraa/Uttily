import type { ReactElement } from 'react';
import type { OverlayProps } from './FullBikeOverlay';

/**
 * Overlay anatomique Ghost pour le slot BRAKES_TIRES.
 *
 * Met en valeur les zones cibles :
 * - Zone concentrique avant : étrier/disque et surface du pneu
 * - Zone concentrique arrière : frein arrière et profil
 */
export function BrakesTiresOverlay({ className }: OverlayProps): ReactElement {
  return (
    <svg
      viewBox="0 0 1000 600"
      className={className}
      aria-hidden="true"
      preserveAspectRatio="xMidYMid meet"
      style={{ pointerEvents: 'none' }}
    >
      {/* Silhouette vélo estompée */}
      <g
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.12}
        strokeWidth="4"
      >
        <line x1="260" y1="400" x2="470" y2="400" />
        <line x1="260" y1="400" x2="410" y2="240" />
        <line x1="470" y1="400" x2="410" y2="240" />
        <line x1="470" y1="400" x2="670" y2="230" />
        <line x1="410" y1="240" x2="670" y2="230" />
        <line x1="670" y1="230" x2="740" y2="400" />
      </g>

      {/* Focus pneumatique et frein avant */}
      <g
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.35}
      >
        {/* Roue avant et bande de roulement */}
        <circle cx="740" cy="400" r="115" strokeWidth="6" />
        <circle cx="740" cy="400" r="125" strokeWidth="3" strokeDasharray="6 4" />
        {/* Étrier / Disque avant */}
        <path d="M720 330 Q730 345 735 360" strokeWidth="6" />
        <circle cx="730" cy="345" r="28" strokeWidth="3" strokeDasharray="6 4" opacity={0.6} />

        {/* Cadre de repère zone avant */}
        <rect
          x="600"
          y="270"
          width="280"
          height="260"
          rx="18"
          strokeWidth="3"
          strokeDasharray="8 6"
          opacity={0.5}
        />
      </g>
    </svg>
  );
}
