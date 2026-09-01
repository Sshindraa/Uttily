'use client';

import type { CSSProperties, ReactNode } from 'react';
import * as React from 'react';

export function Card({
  children,
  as: Element = 'div',
  style,
  ...props
}: {
  children: ReactNode;
  as?: 'aside' | 'div' | 'article' | 'section';
  style?: CSSProperties;
} & React.HTMLAttributes<HTMLElement>): React.JSX.Element {
  return (
    <Element
      {...props}
      style={{
        background: 'var(--ut-color-surface)',
        border: 'var(--ut-border-thin)',
        borderRadius: 'var(--ut-radius-lg)',
        boxShadow: 'var(--ut-shadow-sm)',
        padding: 'var(--ut-space-6)',
        ...style,
      }}
    >
      {children}
    </Element>
  );
}
