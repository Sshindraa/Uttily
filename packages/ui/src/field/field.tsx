'use client';

import type { ReactElement, ReactNode } from 'react';
import * as React from 'react';
import { cloneElement, isValidElement } from 'react';

export function Field({
  label,
  htmlFor,
  help,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  help?: string;
  error?: string;
  children: ReactElement | ReactNode;
}): React.JSX.Element {
  const helpId = help ? `${htmlFor}-help` : undefined;
  const errorId = error ? `${htmlFor}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(' ') || undefined;
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        'aria-describedby': describedBy,
        'aria-invalid': error ? 'true' : undefined,
      })
    : children;
  return (
    <div style={{ display: 'grid', gap: 'var(--ut-space-2)' }}>
      <label
        htmlFor={htmlFor}
        style={{
          color: 'var(--ut-color-ink-strong)',
          fontSize: 'var(--ut-text-sm)',
          fontWeight: 'var(--ut-weight-label)',
          lineHeight: 'var(--ut-leading-ui)',
        }}
      >
        {label}
      </label>
      <div>{control}</div>
      {help && (
        <p
          id={helpId}
          style={{ color: 'var(--ut-color-ink-muted)', fontSize: 'var(--ut-text-sm)', margin: 0 }}
        >
          {help}
        </p>
      )}
      {error && (
        <p
          id={errorId}
          role="alert"
          style={{ color: 'var(--ut-color-danger)', fontSize: 'var(--ut-text-sm)', margin: 0 }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
