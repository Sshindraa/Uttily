'use client';

import type { ButtonHTMLAttributes, CSSProperties } from 'react';
import * as React from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
export type ControlSize = 'sm' | 'md' | 'lg';

const buttonBase: CSSProperties = {
  alignItems: 'center',
  border: '1px solid transparent',
  borderRadius: 'var(--ut-radius-md)',
  cursor: 'pointer',
  display: 'inline-flex',
  fontFamily: 'var(--ut-font-ui)',
  fontWeight: 'var(--ut-weight-action)',
  lineHeight: 'var(--ut-leading-ui)',
  letterSpacing: 'var(--ut-tracking-label)',
  gap: 'var(--ut-space-2)',
  justifyContent: 'center',
  minHeight: '44px',
  padding: '0 var(--ut-space-4)',
  textDecoration: 'none',
  transition:
    'background var(--ut-motion-fast) var(--ut-ease-standard), border-color var(--ut-motion-fast) var(--ut-ease-standard), transform var(--ut-motion-fast) var(--ut-ease-standard)',
};

const buttonVariants: Record<ButtonVariant, CSSProperties> = {
  primary: {
    background: 'var(--ut-color-primary)',
    color: 'var(--ut-color-ink-on-dark)',
  },
  secondary: {
    background: 'var(--ut-color-surface)',
    borderColor: 'var(--ut-color-border-strong)',
    color: 'var(--ut-color-ink-strong)',
  },
  quiet: { background: 'transparent', color: 'var(--ut-color-primary-strong)' },
  danger: {
    background: 'var(--ut-color-danger)',
    color: 'var(--ut-color-ink-on-dark)',
  },
};

const buttonSizes: Record<ControlSize, CSSProperties> = {
  sm: { fontSize: 'var(--ut-text-sm)', minHeight: '40px', paddingInline: 'var(--ut-space-3)' },
  md: { fontSize: 'var(--ut-text-sm)' },
  lg: { fontSize: 'var(--ut-text-md)', minHeight: '52px', paddingInline: 'var(--ut-space-6)' },
};

export function Button({
  variant = 'primary',
  size = 'md',
  style,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ControlSize;
}): React.JSX.Element {
  return (
    <button
      {...props}
      style={{ ...buttonBase, ...buttonVariants[variant], ...buttonSizes[size], ...style }}
    />
  );
}

export function LinkButton({
  href,
  variant = 'primary',
  size = 'md',
  style,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  variant?: ButtonVariant;
  size?: ControlSize;
}): React.JSX.Element {
  return (
    <a
      href={href}
      {...props}
      style={{ ...buttonBase, ...buttonVariants[variant], ...buttonSizes[size], ...style }}
    />
  );
}

export function IconButton({
  label,
  variant = 'quiet',
  size = 'md',
  style,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  variant?: ButtonVariant;
  size?: ControlSize;
}): React.JSX.Element {
  return (
    <Button
      {...props}
      aria-label={label}
      variant={variant}
      size={size}
      style={{ aspectRatio: '1', paddingInline: 0, ...style }}
    />
  );
}
