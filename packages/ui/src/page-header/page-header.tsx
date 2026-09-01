'use client';

import type { ReactNode } from 'react';
import * as React from 'react';

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}): React.JSX.Element {
  return (
    <header
      style={{
        alignItems: 'flex-start',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--ut-space-5)',
        justifyContent: 'space-between',
      }}
    >
      <div>
        {eyebrow && (
          <p
            style={{
              color: 'var(--ut-color-primary)',
              fontSize: 'var(--ut-text-sm)',
              fontWeight: 'var(--ut-weight-label)',
              letterSpacing: 'var(--ut-tracking-eyebrow)',
              margin: '0 0 var(--ut-space-2)',
              textTransform: 'uppercase',
            }}
          >
            {eyebrow}
          </p>
        )}
        <h1
          style={{
            color: 'var(--ut-color-ink-strong)',
            fontFamily: 'var(--ut-font-display)',
            fontSize: 'var(--ut-text-2xl)',
            fontWeight: 'var(--ut-weight-heading)',
            letterSpacing: 'var(--ut-tracking-heading)',
            lineHeight: 'var(--ut-leading-tight)',
            margin: 0,
          }}
        >
          {title}
        </h1>
        {description && (
          <p
            style={{
              color: 'var(--ut-color-ink-muted)',
              margin: 'var(--ut-space-2) 0 0',
              maxWidth: '42rem',
            }}
          >
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div
          style={{
            alignItems: 'center',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--ut-space-2)',
          }}
        >
          {actions}
        </div>
      )}
    </header>
  );
}
