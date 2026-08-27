import type { ReactElement } from 'react';
import type { OverlayProps } from './FullBikeOverlay';

/**
 * Overlay Ghost pour le slot THREE_QUARTER (Vue 3/4 Dynamique).
 *
 * Repère en perspective trois-quarts avant valorisant le volume,
 * l'allure sportive et l'angle du poste de pilotage.
 */
export function ThreeQuarterOverlay({ className }: OverlayProps): ReactElement {
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
        opacity={0.3}
      >
        {/* Roue avant (plus proche, plus grande en perspective 3/4) */}
        <g strokeWidth="6">
          <ellipse cx="660" cy="410" rx="100" ry="125" transform="rotate(-10 660 410)" />
          <circle cx="660" cy="410" r="14" fill="currentColor" />
        </g>

        {/* Roue arrière (en retrait, plus petite) */}
        <g strokeWidth="4">
          <ellipse cx="280" cy="350" rx="70" ry="95" transform="rotate(-8 280 350)" />
          <circle cx="280" cy="350" r="10" fill="currentColor" />
        </g>

        {/* Cadre en perspective fuyante */}
        <g strokeWidth="7">
          {/* Base arrière vers pédalier */}
          <line x1="280" y1="350" x2="450" y2="390" />
          {/* Haubans arrière vers selle */}
          <line x1="280" y1="350" x2="400" y2="250" />
          {/* Tube de selle */}
          <line x1="450" y1="390" x2="400" y2="250" />
          {/* Tube diagonal vers douille avant */}
          <line x1="450" y1="390" x2="600" y2="230" strokeWidth="8" />
          {/* Tube supérieur */}
          <line x1="400" y1="250" x2="600" y2="230" strokeWidth="7" />
          {/* Fourche avant vers roue avant */}
          <line x1="600" y1="230" x2="660" y2="410" strokeWidth="8" />
        </g>

        {/* Poste de pilotage 3/4 avant (guidon profilé vers l'avant) */}
        <g strokeWidth="7">
          <path d="M600 230 L615 180 M560 170 Q615 175 670 170" />
          <path d="M400 250 L390 200 M360 200 H425" strokeWidth="5" />
        </g>

        {/* Pédalier et transmission */}
        <g strokeWidth="4">
          <circle cx="450" cy="390" r="28" />
          <line x1="450" y1="390" x2="440" y2="440" strokeWidth="5" />
          <rect x="425" y="440" width="26" height="8" rx="3" fill="currentColor" />
        </g>

        {/* Cadre de repère perspective 3/4 */}
        <rect
          x="120"
          y="80"
          width="760"
          height="440"
          rx="24"
          strokeWidth="3"
          strokeDasharray="12 8"
          opacity={0.5}
        />
      </g>
    </svg>
  );
}
