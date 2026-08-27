import type { ReactElement } from 'react';
import type { OverlayProps } from './FullBikeOverlay';

/**
 * Overlay Ghost pour le slot SIGNATURE_DETAIL (Détail Signature & Praticité).
 *
 * Repère de mise au point macro ciblé permettant de valoriser
 * l'équipement distinctif : cockpit, écran VAE, panier, finitions.
 */
export function SignatureDetailOverlay({ className }: OverlayProps): ReactElement {
  return (
    <svg
      viewBox="0 0 1000 600"
      className={className}
      aria-hidden="true"
      preserveAspectRatio="xMidYMid meet"
      style={{ pointerEvents: 'none' }}
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.35}
      >
        {/* Réticule central de mise au point macro */}
        <circle cx="500" cy="300" r="140" strokeWidth="4" strokeDasharray="10 6" />
        <circle cx="500" cy="300" r="160" strokeWidth="2" opacity="0.5" />
        <circle cx="500" cy="300" r="12" fill="currentColor" opacity="0.6" />

        {/* Crochets de focus carrés */}
        <g strokeWidth="4">
          <path d="M380 200 H340 V240" />
          <path d="M620 200 H660 V240" />
          <path d="M380 400 H340 V360" />
          <path d="M620 400 H660 V360" />
        </g>

        {/* Repères d'alignement et de niveau */}
        <line x1="220" y1="300" x2="310" y2="300" strokeWidth="3" opacity="0.6" />
        <line x1="690" y1="300" x2="780" y2="300" strokeWidth="3" opacity="0.6" />
        <line x1="500" y1="100" x2="500" y2="130" strokeWidth="3" opacity="0.6" />
        <line x1="500" y1="470" x2="500" y2="500" strokeWidth="3" opacity="0.6" />
      </g>
    </svg>
  );
}
