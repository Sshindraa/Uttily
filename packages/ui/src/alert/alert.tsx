'use client';

import type { ReactNode } from 'react';
import * as React from 'react';
import { badgeTones, type BadgeTone } from '../badge/tone';

export function Alert({
  children,
  tone = 'info',
  title,
}: {
  children: ReactNode;
  tone?: Exclude<BadgeTone, 'neutral'>;
  title?: string;
}): React.JSX.Element {
  const toneStyles = badgeTones[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      style={{ ...toneStyles, borderRadius: 'var(--ut-radius-md)', padding: 'var(--ut-space-4)' }}
    >
      {title && (
        <strong style={{ display: 'block', marginBottom: 'var(--ut-space-1)' }}>{title}</strong>
      )}
      {children}
    </div>
  );
}
