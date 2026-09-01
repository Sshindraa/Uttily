import type { ReactElement } from 'react';

interface CheckoutStatusProps {
  title: string;
  description: string;
}

export function CheckoutStatus({ title, description }: CheckoutStatusProps): ReactElement {
  return (
    <main style={statusStyle}>
      <CheckoutMessage title={title} description={description} />
    </main>
  );
}

export function CheckoutMessage({ title, description }: CheckoutStatusProps): ReactElement {
  return (
    <>
      <h1>{title}</h1>
      <p style={descriptionStyle}>{description}</p>
    </>
  );
}

const statusStyle: React.CSSProperties = {
  maxWidth: 640,
  margin: '4rem auto',
  padding: '1rem',
  textAlign: 'center',
};

const descriptionStyle: React.CSSProperties = {
  color: 'var(--ut-color-ink-muted)',
};
