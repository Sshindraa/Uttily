'use client';

import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';
import * as React from 'react';

export function Input({
  style,
  ...props
}: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <input
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

export function Textarea({
  style,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element {
  return (
    <textarea
      {...props}
      style={{
        background: 'var(--ut-color-surface)',
        border: 'var(--ut-border-control)',
        borderRadius: 'var(--ut-radius-md)',
        color: 'var(--ut-color-ink-strong)',
        fontFamily: 'var(--ut-font-ui)',
        fontSize: 'var(--ut-text-control)',
        letterSpacing: 'var(--ut-tracking-label)',
        minHeight: '120px',
        padding: 'var(--ut-space-3)',
        width: '100%',
        ...style,
      }}
    />
  );
}
