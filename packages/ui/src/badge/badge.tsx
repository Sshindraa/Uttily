'use client';

import type { ReactNode } from 'react';
import * as React from 'react';
import { badgeTones, type BadgeTone } from './tone';

export type { BadgeTone } from './tone';

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: BadgeTone;
}): React.JSX.Element {
  return (
    <span
      style={{
        ...badgeTones[tone],
        borderRadius: 'var(--ut-radius-pill)',
        display: 'inline-flex',
        fontFamily: 'var(--ut-font-ui)',
        fontSize: 'var(--ut-text-xs)',
        fontWeight: 'var(--ut-weight-bold)',
        letterSpacing: 'var(--ut-tracking-label)',
        padding: 'var(--ut-space-1) var(--ut-space-3)',
      }}
    >
      {children}
    </span>
  );
}
