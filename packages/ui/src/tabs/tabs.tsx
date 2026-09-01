'use client';

import * as React from 'react';

export function Tabs({
  items,
  active,
  onChange,
}: {
  items: Array<{ id: string; label: string }>;
  active: string;
  onChange?: (id: string) => void;
}): React.JSX.Element {
  return (
    <div
      role="tablist"
      style={{
        borderBottom: 'var(--ut-border-thin)',
        display: 'flex',
        gap: 'var(--ut-space-1)',
        overflowX: 'auto',
      }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={active === item.id}
          onClick={() => onChange?.(item.id)}
          style={{
            background: active === item.id ? 'var(--ut-color-primary-soft)' : 'transparent',
            border: 0,
            borderBottom:
              active === item.id ? '2px solid var(--ut-color-primary)' : '2px solid transparent',
            color:
              active === item.id ? 'var(--ut-color-primary-strong)' : 'var(--ut-color-ink-muted)',
            cursor: 'pointer',
            fontWeight: 'var(--ut-weight-semibold)',
            minHeight: '44px',
            padding: '0 var(--ut-space-3)',
            whiteSpace: 'nowrap',
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
