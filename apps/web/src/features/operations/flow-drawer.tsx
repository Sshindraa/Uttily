'use client';

import type { ReactNode } from 'react';
import { useEffect, useId, useRef } from 'react';

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

interface FlowDrawerProps {
  open: boolean;
  title: string;
  closeDisabled: boolean;
  onClose: () => void;
  children: ReactNode;
}

/** Sheet partagé par les flows comptoir : focus, Escape et restauration inclus. */
export function FlowDrawer({
  open,
  title,
  closeDisabled,
  onClose,
  children,
}: FlowDrawerProps): React.ReactElement | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const panel = panelRef.current;
    const firstFocusable = panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (firstFocusable ?? panel)?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [open]);

  if (!open) return null;

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!closeDisabled) onCloseRef.current();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
    ).filter((element) => !element.hasAttribute('disabled'));
    if (focusable.length === 0) {
      event.preventDefault();
      panelRef.current?.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={handleKeyDown}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        backgroundColor: 'var(--ut-color-overlay)',
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        style={{
          background: 'var(--ut-color-surface)',
          borderLeft: 'var(--ut-border-thin)',
          boxShadow: 'var(--ut-shadow-lg)',
          color: 'var(--ut-color-ink)',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.25rem',
          height: '100%',
          marginLeft: 'auto',
          maxWidth: 'min(100%, 38rem)',
          overflowY: 'auto',
          padding: '1.5rem',
          width: '100%',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2
            id={titleId}
            style={{
              color: 'var(--ut-color-ink-strong)',
              fontSize: '1.15rem',
              fontWeight: 'var(--ut-weight-bold)',
              margin: 0,
            }}
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={closeDisabled}
            aria-label="Fermer"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--ut-color-ink-muted)',
              cursor: closeDisabled ? 'not-allowed' : 'pointer',
              fontSize: '1.5rem',
              lineHeight: 1,
              padding: '0.25rem',
            }}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
