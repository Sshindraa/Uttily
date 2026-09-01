'use client';

import * as React from 'react';
import { Spinner } from '../spinner';

export function LoadingState({
  label = 'Chargement en cours',
}: {
  label?: string;
}): React.JSX.Element {
  return (
    <div
      aria-busy="true"
      role="status"
      style={{
        alignItems: 'center',
        color: 'var(--ut-color-ink-muted)',
        display: 'flex',
        gap: 'var(--ut-space-3)',
        justifyContent: 'center',
        padding: 'var(--ut-space-8)',
      }}
    >
      <Spinner label={label} />
      {label}
    </div>
  );
}
