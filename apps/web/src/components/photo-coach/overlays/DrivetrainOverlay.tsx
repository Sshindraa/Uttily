import type { ReactElement } from 'react';
import type { OverlayProps } from './FullBikeOverlay';

/**
 * Overlay anatomique Ghost pour le slot DRIVETRAIN.
 *
 * Met en valeur la géométrie anatomique précise :
 * - Cercle repère autour du plateau/manivelle (boîtier de pédalier)
 * - Cercle repère autour de la cassette arrière
 * - Ligne filaire tendue pour la chaîne
 */
export function DrivetrainOverlay({ className }: OverlayProps): ReactElement {
  return (
    <svg
      viewBox="0 0 1000 600"
      className={className}
      aria-hidden="true"
      preserveAspectRatio="xMidYMid meet"
      style={{ pointerEvents: 'none' }}
    >
      {/* Silhouette générale du vélo très estompée (15%) pour l'échelle */}
      <g
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.12}
        strokeWidth="4"
      >
        <circle cx="260" cy="400" r="115" />
        <circle cx="740" cy="400" r="115" />
        <line x1="260" y1="400" x2="470" y2="400" />
        <line x1="260" y1="400" x2="410" y2="240" />
        <line x1="470" y1="400" x2="410" y2="240" />
        <line x1="470" y1="400" x2="670" y2="230" />
        <line x1="410" y1="240" x2="670" y2="230" />
        <line x1="670" y1="230" x2="740" y2="400" />
      </g>

      {/* Repères anatomiques précis de la transmission (opacité renforcée 35%) */}
      <g
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.35}
      >
        {/* Plateau et boîtier */}
        <circle cx="470" cy="400" r="48" strokeWidth="4" strokeDasharray="6 4" />
        <circle cx="470" cy="400" r="34" strokeWidth="6" />
        <circle cx="470" cy="400" r="10" fill="currentColor" />
        <line x1="470" y1="400" x2="470" y2="455" strokeWidth="6" />
        <rect x="455" y="455" width="30" height="8" rx="3" fill="currentColor" />

        {/* Cassette arrière */}
        <circle cx="260" cy="400" r="32" strokeWidth="4" strokeDasharray="6 4" />
        <circle cx="260" cy="400" r="22" strokeWidth="5" />

        {/* Chaîne supérieure et inférieure */}
        <path d="M470 366 L260 378 M260 422 L470 434" strokeWidth="5" strokeDasharray="10 6" />

        {/* Cadre de mise au point zone transmission */}
        <rect
          x="200"
          y="320"
          width="330"
          height="170"
          rx="16"
          strokeWidth="3"
          strokeDasharray="8 6"
          opacity={0.5}
        />
      </g>
    </svg>
  );
}
