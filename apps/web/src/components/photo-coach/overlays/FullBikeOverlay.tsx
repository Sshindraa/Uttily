import type { ReactElement } from 'react';

export interface OverlayProps {
  className?: string | undefined;
}

/**
 * Overlay anatomique Ghost pour le slot FULL_BIKE.
 *
 * Dérivé directement de bike-side-master.svg.
 * Calque SVG purement client superposé au viseur vidéo, jamais incrusté dans la capture.
 */
export function FullBikeOverlay({ className }: OverlayProps): ReactElement {
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
        opacity={0.28}
      >
        {/* Roues & Moyeu */}
        <g strokeWidth="5">
          <circle cx="260" cy="400" r="115" />
          <circle cx="260" cy="400" r="12" fill="currentColor" />
          <circle cx="740" cy="400" r="115" />
          <circle cx="740" cy="400" r="12" fill="currentColor" />
        </g>

        {/* Cadre géométrique */}
        <g strokeWidth="7">
          <line x1="260" y1="400" x2="470" y2="400" />
          <line x1="260" y1="400" x2="410" y2="240" />
          <line x1="470" y1="400" x2="410" y2="240" />
          <line x1="470" y1="400" x2="670" y2="230" />
          <line x1="410" y1="240" x2="670" y2="230" />
          <line x1="670" y1="230" x2="740" y2="400" />
        </g>

        {/* Poste de pilotage & Selle */}
        <g strokeWidth="6">
          <path d="M670 230 L685 185 Q690 170 710 175 Q725 180 730 195" />
          <path
            d="M410 240 L395 190 M365 190 Q395 185 435 190 Q405 198 365 190 Z"
            fill="currentColor"
          />
        </g>

        {/* Transmission côté droit face au viseur */}
        <g strokeWidth="4">
          <circle cx="470" cy="400" r="34" strokeWidth="5" />
          <circle cx="470" cy="400" r="8" fill="currentColor" />
          <line x1="470" y1="400" x2="470" y2="455" strokeWidth="5" />
          <rect x="455" y="455" width="30" height="7" rx="3" fill="currentColor" />
          <circle cx="260" cy="400" r="22" />
          <path d="M470 366 L260 378 M260 422 L470 434" strokeDasharray="8 4" />
        </g>

        {/* Repère de cadrage avec marges respirantes (10%) */}
        <rect
          x="90"
          y="80"
          width="820"
          height="440"
          rx="24"
          strokeWidth="3"
          strokeDasharray="12 8"
          opacity={0.6}
        />
      </g>
    </svg>
  );
}
