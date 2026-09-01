'use client';

import type { ReactNode } from 'react';
import * as React from 'react';

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div
      style={{
        background: 'var(--ut-color-surface)',
        border: '1px dashed var(--ut-color-border-strong)',
        borderRadius: 'var(--ut-radius-lg)',
        padding: 'var(--ut-space-10) var(--ut-space-6)',
        textAlign: 'center',
      }}
    >
      <h2 style={{ color: 'var(--ut-color-ink-strong)', fontSize: 'var(--ut-text-lg)', margin: 0 }}>
        {title}
      </h2>
      <p
        style={{
          color: 'var(--ut-color-ink-muted)',
          margin: 'var(--ut-space-2) auto var(--ut-space-5)',
          maxWidth: '36rem',
        }}
      >
        {description}
      </p>
      {action}
    </div>
  );
}
