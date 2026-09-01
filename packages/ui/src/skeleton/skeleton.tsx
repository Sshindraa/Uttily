'use client';

import * as React from 'react';

export function Skeleton({
  width = '100%',
  height = '1rem',
}: {
  width?: string;
  height?: string;
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      style={{
        animation: 'ut-pulse 1.4s ease-in-out infinite',
        background: 'var(--ut-color-border)',
        borderRadius: 'var(--ut-radius-sm)',
        display: 'block',
        height,
        width,
      }}
    />
  );
}
