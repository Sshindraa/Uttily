'use client';

import * as React from 'react';

export function Spinner({ label = 'Chargement' }: { label?: string }): React.JSX.Element {
  return (
    <span
      role="status"
      aria-label={label}
      style={{
        animation: 'ut-spin 0.8s linear infinite',
        border: '2px solid currentColor',
        borderBottomColor: 'transparent',
        borderRadius: '50%',
        display: 'inline-block',
        height: '1.1rem',
        width: '1.1rem',
      }}
    />
  );
}
