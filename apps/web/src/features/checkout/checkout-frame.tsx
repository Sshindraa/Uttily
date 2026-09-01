import type { ReactNode, ReactElement } from 'react';

export function CheckoutFrame({ children }: { children: ReactNode }): ReactElement {
  return <main style={frameStyle}>{children}</main>;
}

const frameStyle: React.CSSProperties = {
  maxWidth: '32.5rem',
  margin: '2rem auto',
  padding: 'var(--ut-space-6) var(--ut-space-4)',
  color: 'var(--ut-color-ink)',
};
