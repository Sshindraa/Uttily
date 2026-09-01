'use client';

import type { ReactNode } from 'react';
import * as React from 'react';

export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div
      style={{
        alignItems: 'baseline',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--ut-space-3)',
        justifyContent: 'space-between',
      }}
    >
      <div>
        <h2
          style={{
            color: 'var(--ut-color-ink-strong)',
            fontSize: 'var(--ut-text-title-sm)',
            fontWeight: 'var(--ut-weight-heading)',
            letterSpacing: 'var(--ut-tracking-heading)',
            lineHeight: 'var(--ut-leading-tight)',
            margin: 0,
          }}
        >
          {title}
        </h2>
        {description && (
          <p style={{ color: 'var(--ut-color-ink-muted)', margin: 'var(--ut-space-1) 0 0' }}>
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}
