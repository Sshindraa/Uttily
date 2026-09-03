'use client';

import type { SelectHTMLAttributes } from 'react';
import * as React from 'react';

export function Select({
  style,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <select
      {...props}
      style={{
        background: 'var(--ut-color-surface)',
        border: 'var(--ut-border-control)',
        borderRadius: 'var(--ut-radius-md)',
        color: 'var(--ut-color-ink-strong)',
        fontFamily: 'var(--ut-font-ui)',
        fontSize: 'var(--ut-text-control)',
        letterSpacing: 'var(--ut-tracking-label)',
        minHeight: '48px',
        padding: '0 var(--ut-space-3)',
        width: '100%',
        ...style,
      }}
    />
  );
}
