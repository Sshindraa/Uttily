'use client';

import type { ReactNode } from 'react';
import * as React from 'react';
import { useEffect, useRef } from 'react';

export function Dialog({
  open,
  title,
  children,
  onClose,
  nativeModal = false,
  className,
  closeLabel = 'Fermer',
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  nativeModal?: boolean;
  className?: string | undefined;
  closeLabel?: string;
}): React.JSX.Element | null {
  const ref = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const titleId = React.useId();
  useEffect(() => {
    if (!open) return;
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    const previousOverflow = document.body.style.overflow;
    if (nativeModal) {
      dialog?.showModal();
      document.body.style.overflow = 'hidden';
    }
    ref.current?.focus();
    return () => {
      if (nativeModal) {
        dialog?.close();
        document.body.style.overflow = previousOverflow;
      }
      previousFocus.current?.focus();
    };
  }, [open, nativeModal]);
  if (!open) return null;
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      ref.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((element) => !element.hasAttribute('disabled'));
    if (focusable.length === 0) {
      event.preventDefault();
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
  };
  return (
    <dialog
      open={nativeModal ? undefined : true}
      className={className}
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-modal="true"
      ref={ref}
      onKeyDown={handleKeyDown}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      style={{
        background: 'var(--ut-color-surface)',
        border: 'var(--ut-border-thin)',
        borderRadius: 'var(--ut-radius-lg)',
        boxShadow: 'var(--ut-shadow-lg)',
        color: 'var(--ut-color-ink)',
        maxWidth: 'min(90vw, 32rem)',
        padding: 'var(--ut-space-6)',
        width: '100%',
        zIndex: 'var(--ut-z-dialog)',
      }}
    >
      <div
        style={{
          alignItems: 'center',
          display: 'flex',
          justifyContent: 'space-between',
          marginBottom: 'var(--ut-space-4)',
        }}
      >
        <h2
          id={titleId}
          style={{ color: 'var(--ut-color-ink-strong)', fontSize: 'var(--ut-text-lg)', margin: 0 }}
        >
          {title}
        </h2>
        <button
          type="button"
          aria-label={closeLabel}
          onClick={onClose}
          style={{
            background: 'transparent',
            border: 0,
            color: 'var(--ut-color-ink-muted)',
            cursor: 'pointer',
            fontSize: '1.5rem',
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
