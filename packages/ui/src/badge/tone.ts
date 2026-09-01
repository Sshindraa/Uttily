import type { CSSProperties } from 'react';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export const badgeTones: Record<BadgeTone, CSSProperties> = {
  neutral: { background: 'var(--ut-color-surface-soft)', color: 'var(--ut-color-ink)' },
  success: { background: 'var(--ut-color-success-soft)', color: 'var(--ut-color-success)' },
  warning: { background: 'var(--ut-color-warning-soft)', color: 'var(--ut-color-warning)' },
  danger: { background: 'var(--ut-color-danger-soft)', color: 'var(--ut-color-danger)' },
  info: { background: 'var(--ut-color-primary-soft)', color: 'var(--ut-color-primary-strong)' },
};
