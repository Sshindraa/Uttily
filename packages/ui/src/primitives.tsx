'use client';

import type {
  ReactNode,
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  SelectHTMLAttributes,
  ReactElement,
} from 'react';
import * as React from 'react';
import { cloneElement, isValidElement, useEffect, useRef, type CSSProperties } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
export type ControlSize = 'sm' | 'md' | 'lg';

const buttonBase: CSSProperties = {
  alignItems: 'center',
  border: '1px solid transparent',
  borderRadius: 'var(--ut-radius-md)',
  cursor: 'pointer',
  display: 'inline-flex',
  fontWeight: 'var(--ut-weight-semibold)',
  gap: 'var(--ut-space-2)',
  justifyContent: 'center',
  minHeight: '44px',
  padding: '0 var(--ut-space-4)',
  textDecoration: 'none',
  transition:
    'background var(--ut-motion-fast) var(--ut-ease-standard), border-color var(--ut-motion-fast) var(--ut-ease-standard), transform var(--ut-motion-fast) var(--ut-ease-standard)',
};

const buttonVariants: Record<ButtonVariant, CSSProperties> = {
  primary: { background: 'var(--ut-color-primary)', color: 'white' },
  secondary: {
    background: 'var(--ut-color-surface)',
    borderColor: 'var(--ut-color-border-strong)',
    color: 'var(--ut-color-ink-strong)',
  },
  quiet: { background: 'transparent', color: 'var(--ut-color-primary-strong)' },
  danger: { background: 'var(--ut-color-danger)', color: 'white' },
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

export function Input({
  style,
  ...props
}: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <input
      {...props}
      style={{
        background: 'var(--ut-color-surface)',
        border: 'var(--ut-border-thin)',
        borderRadius: 'var(--ut-radius-md)',
        color: 'var(--ut-color-ink-strong)',
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
        border: 'var(--ut-border-thin)',
        borderRadius: 'var(--ut-radius-md)',
        color: 'var(--ut-color-ink-strong)',
        minHeight: '120px',
        padding: 'var(--ut-space-3)',
        width: '100%',
        ...style,
      }}
    />
  );
}

export function Select({
  style,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <select
      {...props}
      style={{
        background: 'var(--ut-color-surface)',
        border: 'var(--ut-border-thin)',
        borderRadius: 'var(--ut-radius-md)',
        color: 'var(--ut-color-ink-strong)',
        minHeight: '48px',
        padding: '0 var(--ut-space-3)',
        width: '100%',
        ...style,
      }}
    />
  );
}

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
          fontWeight: 'var(--ut-weight-semibold)',
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

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
const badgeTones: Record<BadgeTone, CSSProperties> = {
  neutral: { background: 'var(--ut-color-surface-soft)', color: 'var(--ut-color-ink)' },
  success: { background: 'var(--ut-color-success-soft)', color: 'var(--ut-color-success)' },
  warning: { background: 'var(--ut-color-warning-soft)', color: 'var(--ut-color-warning)' },
  danger: { background: 'var(--ut-color-danger-soft)', color: 'var(--ut-color-danger)' },
  info: { background: 'var(--ut-color-primary-soft)', color: 'var(--ut-color-primary-strong)' },
};

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: BadgeTone;
}): React.JSX.Element {
  return (
    <span
      style={{
        ...badgeTones[tone],
        borderRadius: 'var(--ut-radius-pill)',
        display: 'inline-flex',
        fontSize: 'var(--ut-text-xs)',
        fontWeight: 'var(--ut-weight-bold)',
        letterSpacing: '0.02em',
        padding: 'var(--ut-space-1) var(--ut-space-3)',
      }}
    >
      {children}
    </span>
  );
}

export function Alert({
  children,
  tone = 'info',
  title,
}: {
  children: ReactNode;
  tone?: Exclude<BadgeTone, 'neutral'>;
  title?: string;
}): React.JSX.Element {
  const toneStyles = badgeTones[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      style={{ ...toneStyles, borderRadius: 'var(--ut-radius-md)', padding: 'var(--ut-space-4)' }}
    >
      {title && (
        <strong style={{ display: 'block', marginBottom: 'var(--ut-space-1)' }}>{title}</strong>
      )}
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div
      style={{
        background: 'var(--ut-color-surface)',
        border: '1px dashed var(--ut-color-border-strong)',
        borderRadius: 'var(--ut-radius-lg)',
        padding: 'var(--ut-space-10) var(--ut-space-6)',
        textAlign: 'center',
      }}
    >
      <h2 style={{ color: 'var(--ut-color-ink-strong)', fontSize: 'var(--ut-text-lg)', margin: 0 }}>
        {title}
      </h2>
      <p
        style={{
          color: 'var(--ut-color-ink-muted)',
          margin: 'var(--ut-space-2) auto var(--ut-space-5)',
          maxWidth: '36rem',
        }}
      >
        {description}
      </p>
      {action}
    </div>
  );
}

export function Spinner({ label = 'Chargement' }: { label?: string }): React.JSX.Element {
  return (
    <span
      role="status"
      aria-label={label}
      style={{
        animation: 'ut-spin 0.8s linear infinite',
        border: '2px solid currentColor',
        borderBottomColor: 'transparent',
        borderRadius: '50%',
        display: 'inline-block',
        height: '1.1rem',
        width: '1.1rem',
      }}
    />
  );
}

export function LoadingState({
  label = 'Chargement en cours',
}: {
  label?: string;
}): React.JSX.Element {
  return (
    <div
      aria-busy="true"
      role="status"
      style={{
        alignItems: 'center',
        color: 'var(--ut-color-ink-muted)',
        display: 'flex',
        gap: 'var(--ut-space-3)',
        justifyContent: 'center',
        padding: 'var(--ut-space-8)',
      }}
    >
      <Spinner label={label} />
      {label}
    </div>
  );
}

export function Skeleton({
  width = '100%',
  height = '1rem',
}: {
  width?: string;
  height?: string;
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      style={{
        animation: 'ut-pulse 1.4s ease-in-out infinite',
        background: 'var(--ut-color-border)',
        borderRadius: 'var(--ut-radius-sm)',
        display: 'block',
        height,
        width,
      }}
    />
  );
}

export function Dialog({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
}): React.JSX.Element | null {
  const ref = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const titleId = React.useId();
  useEffect(() => {
    if (!open) return;
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    return () => previousFocus.current?.focus();
  }, [open]);
  if (!open) return null;
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === 'Escape') {
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
      open
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-modal="true"
      ref={ref}
      onKeyDown={handleKeyDown}
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
          aria-label="Fermer"
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

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}): React.JSX.Element {
  return (
    <header
      style={{
        alignItems: 'flex-start',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--ut-space-5)',
        justifyContent: 'space-between',
      }}
    >
      <div>
        {eyebrow && (
          <p
            style={{
              color: 'var(--ut-color-primary)',
              fontSize: 'var(--ut-text-sm)',
              fontWeight: 'var(--ut-weight-bold)',
              letterSpacing: '0.08em',
              margin: '0 0 var(--ut-space-2)',
              textTransform: 'uppercase',
            }}
          >
            {eyebrow}
          </p>
        )}
        <h1
          style={{
            color: 'var(--ut-color-ink-strong)',
            fontFamily: 'var(--ut-font-display)',
            fontSize: 'var(--ut-text-2xl)',
            lineHeight: 'var(--ut-leading-tight)',
            margin: 0,
          }}
        >
          {title}
        </h1>
        {description && (
          <p
            style={{
              color: 'var(--ut-color-ink-muted)',
              margin: 'var(--ut-space-2) 0 0',
              maxWidth: '42rem',
            }}
          >
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div
          style={{
            alignItems: 'center',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--ut-space-2)',
          }}
        >
          {actions}
        </div>
      )}
    </header>
  );
}

export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div
      style={{
        alignItems: 'baseline',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--ut-space-3)',
        justifyContent: 'space-between',
      }}
    >
      <div>
        <h2
          style={{
            color: 'var(--ut-color-ink-strong)',
            fontSize: 'var(--ut-text-lg)',
            lineHeight: 'var(--ut-leading-tight)',
            margin: 0,
          }}
        >
          {title}
        </h2>
        {description && (
          <p style={{ color: 'var(--ut-color-ink-muted)', margin: 'var(--ut-space-1) 0 0' }}>
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}

export type IconName =
  | 'arrow-right'
  | 'calendar'
  | 'check'
  | 'chevron-down'
  | 'home'
  | 'menu'
  | 'pin'
  | 'search'
  | 'settings'
  | 'users'
  | 'wallet'
  | 'bike'
  | 'x';

const iconPaths: Record<IconName, ReactNode> = {
  'arrow-right': (
    <>
      <path d="M4 12h16" />
      <path d="m13 5 7 7-7 7" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  home: (
    <>
      <path d="m3 11 9-8 9 8" />
      <path d="M5 10v10h14V10M9 20v-6h6v6" />
    </>
  ),
  menu: (
    <>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </>
  ),
  pin: (
    <>
      <path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" />
      <circle cx="12" cy="10" r="2.5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.06.06-1.42 1.42-.06-.06a1.8 1.8 0 0 0-1.98-.36 1.8 1.8 0 0 0-1.08 1.65V20h-2v-.31a1.8 1.8 0 0 0-1.08-1.65 1.8 1.8 0 0 0-1.98.36l-.06.06-1.42-1.42.06-.06A1.8 1.8 0 0 0 9.16 15a1.8 1.8 0 0 0-1.65-1.08H7v-2h.51A1.8 1.8 0 0 0 9.16 9.8a1.8 1.8 0 0 0-.36-1.98l-.06-.06 1.42-1.42.06.06a1.8 1.8 0 0 0 1.98.36A1.8 1.8 0 0 0 13.28 5V4h2v1a1.8 1.8 0 0 0 1.08 1.65 1.8 1.8 0 0 0 1.98-.36l.06-.06 1.42 1.42-.06.06A1.8 1.8 0 0 0 19.4 9.8a1.8 1.8 0 0 0 1.65 1.08H21v2h-.51A1.8 1.8 0 0 0 19.4 15Z" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  wallet: (
    <>
      <path d="M4 5h15a2 2 0 0 1 2 2v12H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
      <path d="M2 8h19M16 14h3" />
    </>
  ),
  bike: (
    <>
      <circle cx="5" cy="17" r="3" />
      <circle cx="19" cy="17" r="3" />
      <path d="m5 17 4-8 4 8m-4-8h5l2 4H9m4 4 3-8h3" />
    </>
  ),
  x: (
    <>
      <path d="m6 6 12 12M18 6 6 18" />
    </>
  ),
};

export function Icon({ name, size = 20 }: { name: IconName; size?: number }): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    >
      {iconPaths[name]}
    </svg>
  );
}
