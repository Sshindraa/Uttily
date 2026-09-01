'use client';

import React, { useState, useEffect, useRef, useCallback, type ReactElement } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { initiateSupplementPaymentAction } from '@/app/actions/booking-amendments';
import { getEmbeddedFonts, getPaymentAppearance } from '@/lib/typography';

interface SupplementCheckoutClientProps {
  amendmentId: string;
  amountMinor: number;
  currency: string;
  holdDeadline: string;
  timeZone: string;
}

type Phase = 'initializing' | 'ready' | 'success' | 'error';

let stripePromise: Promise<Stripe | null> | null = null;

function getStripePromise(): Promise<Stripe | null> {
  if (!stripePromise) {
    const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    if (!key) {
      return Promise.resolve(null);
    }
    stripePromise = loadStripe(key);
  }
  return stripePromise;
}

export function formatAmount(minor: number, currency: string): string {
  return (minor / 100).toLocaleString('fr-FR', {
    style: 'currency',
    currency,
  });
}

export function formatHoldDeadline(isoString: string, timeZone: string): string {
  try {
    const date = new Date(isoString);
    if (!Number.isFinite(date.getTime())) return 'date non disponible';
    return new Intl.DateTimeFormat('fr-FR', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone,
    }).format(date);
  } catch {
    return 'date non disponible';
  }
}

export function isHoldExpired(
  holdDeadline: number | string | Date,
  nowMs: number = Date.now(),
): boolean {
  const deadlineMs =
    typeof holdDeadline === 'number'
      ? holdDeadline
      : typeof holdDeadline === 'string'
        ? new Date(holdDeadline).getTime()
        : holdDeadline.getTime();
  if (!Number.isFinite(deadlineMs)) return true;
  return nowMs >= deadlineMs;
}

export function mapStripeErrorToSafeMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'type' in error) {
    const stripeErr = error as { type?: unknown };
    if (stripeErr.type === 'card_error' || stripeErr.type === 'validation_error') {
      return 'Votre moyen de paiement a été refusé ou contient des informations invalides.';
    }
  }
  return 'Une erreur est survenue lors de la validation du paiement.';
}

export function canSubmitPayment(params: {
  stripe: boolean;
  elements: boolean;
  submitting: boolean;
  isExpired: boolean;
  holdDeadlineMs: number;
  nowMs?: number;
}): {
  canSubmit: boolean;
  reason?: 'MISSING_STRIPE' | 'MISSING_ELEMENTS' | 'ALREADY_SUBMITTING' | 'EXPIRED';
} {
  const now = params.nowMs ?? Date.now();
  if (params.submitting) return { canSubmit: false, reason: 'ALREADY_SUBMITTING' };
  if (params.isExpired || now >= params.holdDeadlineMs)
    return { canSubmit: false, reason: 'EXPIRED' };
  if (!params.stripe) return { canSubmit: false, reason: 'MISSING_STRIPE' };
  if (!params.elements) return { canSubmit: false, reason: 'MISSING_ELEMENTS' };
  return { canSubmit: true };
}

interface PaymentFormProps {
  totalLabel: string;
  holdDeadlineMs: number;
  isExpired: boolean;
  onSuccess: () => void;
  onError: (safeErrorMessage: string) => void;
}

function PaymentForm({
  totalLabel,
  holdDeadlineMs,
  isExpired,
  onSuccess,
}: PaymentFormProps): ReactElement {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const check = canSubmitPayment({
      stripe: Boolean(stripe),
      elements: Boolean(elements),
      submitting,
      isExpired,
      holdDeadlineMs,
    });

    if (!check.canSubmit) {
      if (check.reason === 'EXPIRED') {
        setFormError('Le délai de paiement a expiré.');
      }
      return;
    }

    setSubmitting(true);
    setFormError(null);

    try {
      const result = await stripe!.confirmPayment({
        elements: elements!,
        redirect: 'if_required',
      });

      if (result.error) {
        setFormError(mapStripeErrorToSafeMessage(result.error));
        setSubmitting(false);
      } else {
        onSuccess();
      }
    } catch {
      setFormError('Une erreur est survenue lors de la validation du paiement.');
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={formStyle} data-testid="supplement-payment-form">
      <PaymentElement
        options={{
          layout: 'tabs',
        }}
      />

      {formError && (
        <p role="alert" style={errorStyle} data-testid="payment-form-error">
          {formError}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || isExpired || !stripe || !elements}
        style={{
          ...submitButtonStyle,
          opacity: submitting || isExpired || !stripe || !elements ? 0.6 : 1,
          cursor: submitting || isExpired || !stripe || !elements ? 'not-allowed' : 'pointer',
        }}
        data-testid="supplement-pay-button"
      >
        {submitting ? 'Validation en cours…' : `Payer ${totalLabel}`}
      </button>
    </form>
  );
}

export function SupplementCheckoutClient({
  amendmentId,
  amountMinor,
  currency,
  holdDeadline,
  timeZone,
}: SupplementCheckoutClientProps): ReactElement {
  const deadlineMs = new Date(holdDeadline).getTime();
  const [isExpired, setIsExpired] = useState(() => isHoldExpired(holdDeadline));
  const [phase, setPhase] = useState<Phase>('initializing');
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [stripe, setStripe] = useState<Stripe | null | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const initiatedRef = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const successRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (isExpired) return;
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      setIsExpired(true);
      return;
    }
    const timer = setTimeout(() => {
      setIsExpired(true);
    }, remainingMs);
    return () => clearTimeout(timer);
  }, [deadlineMs, isExpired]);

  const handleInitiate = useCallback(async () => {
    if (isHoldExpired(deadlineMs)) {
      setIsExpired(true);
      return;
    }
    setPhase('initializing');
    setErrorMessage(null);
    try {
      const result = await initiateSupplementPaymentAction({ amendmentId });
      if (result.kind === 'READY') {
        setClientSecret(result.clientSecret);
        setPhase('ready');
      } else {
        setErrorMessage(result.message);
        setPhase('error');
      }
    } catch {
      setErrorMessage('Une erreur temporaire est survenue. Veuillez réessayer.');
      setPhase('error');
    }
  }, [amendmentId, deadlineMs]);

  useEffect(() => {
    if (initiatedRef.current) return;
    initiatedRef.current = true;
    handleInitiate();
  }, [handleInitiate]);

  useEffect(() => {
    if (phase === 'ready' && stripe === undefined) {
      let cancelled = false;
      getStripePromise().then((s) => {
        if (!cancelled) setStripe(s);
      });
      return () => {
        cancelled = true;
      };
    }
  }, [phase, stripe]);

  useEffect(() => {
    if (phase === 'error') {
      errorRef.current?.focus();
    } else if (phase === 'success') {
      successRef.current?.focus();
    }
  }, [phase]);

  const totalLabel = formatAmount(amountMinor, currency);
  const formattedDeadline = formatHoldDeadline(holdDeadline, timeZone);

  if (isExpired) {
    return (
      <section
        aria-labelledby="expired-heading"
        style={cardStyle}
        data-testid="supplement-expired-section"
      >
        <h2
          id="expired-heading"
          style={{ fontSize: '1.25rem', margin: 0, color: 'var(--ut-color-danger)' }}
        >
          Délai de paiement expiré
        </h2>
        <p role="alert" style={errorStyle} data-testid="supplement-expired-message">
          Le délai de 10 minutes pour régler cette modification a expiré. Les articles associés ont
          été libérés.
        </p>
      </section>
    );
  }

  if (phase === 'success') {
    return (
      <section
        aria-labelledby="success-heading"
        style={cardStyle}
        data-testid="supplement-success-section"
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div
            style={{
              width: '2.5rem',
              height: '2.5rem',
              borderRadius: '9999px',
              backgroundColor: 'var(--ut-color-success-soft)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--ut-color-success)',
              fontSize: '1.25rem',
            }}
          >
            ✓
          </div>
          <div>
            <h2
              id="success-heading"
              ref={successRef}
              tabIndex={-1}
              style={{
                fontSize: '1.25rem',
                fontWeight: 'var(--ut-weight-semibold)',
                margin: 0,
                outline: 'none',
              }}
            >
              Paiement soumis
            </h2>
          </div>
        </div>
        <p
          style={{
            margin: 0,
            color: 'var(--ut-color-success-strong)',
            fontSize: '0.95rem',
            lineHeight: 1.5,
          }}
        >
          Paiement soumis. La modification sera appliquée automatiquement après confirmation du
          paiement.
        </p>
      </section>
    );
  }

  if (phase === 'error') {
    return (
      <section
        aria-labelledby="error-heading"
        style={cardStyle}
        data-testid="supplement-error-section"
      >
        <h2
          id="error-heading"
          style={{ fontSize: '1.25rem', margin: 0, color: 'var(--ut-color-danger)' }}
        >
          Erreur
        </h2>
        <p
          ref={errorRef}
          role="alert"
          tabIndex={-1}
          style={errorStyle}
          data-testid="supplement-error-message"
        >
          {errorMessage ?? 'Une erreur est survenue.'}
        </p>
        <button
          type="button"
          onClick={handleInitiate}
          style={submitButtonStyle}
          data-testid="supplement-retry-button"
        >
          Réessayer
        </button>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="checkout-summary-heading"
      style={cardStyle}
      data-testid="supplement-checkout-section"
    >
      <h2 id="checkout-summary-heading" style={visuallyHiddenStyle}>
        Récapitulatif et paiement du supplément
      </h2>

      <div style={summaryBoxStyle}>
        <div style={rowStyle}>
          <span style={{ color: 'var(--ut-color-ink)' }}>Montant du supplément</span>
          <strong style={{ fontSize: '1.25rem', color: 'var(--ut-color-ink-strong)' }}>
            {totalLabel}
          </strong>
        </div>
        <div
          style={{
            ...rowStyle,
            marginTop: '0.75rem',
            fontSize: '0.875rem',
            color: 'var(--ut-color-ink-muted)',
          }}
        >
          <span>Échéance de réservation</span>
          <span>
            Avant {formattedDeadline} ({timeZone})
          </span>
        </div>
      </div>

      {phase === 'initializing' && (
        <p
          aria-busy="true"
          role="status"
          style={{ textAlign: 'center', color: 'var(--ut-color-ink)' }}
        >
          Préparation du paiement sécurisé…
        </p>
      )}

      {phase === 'ready' && (
        <>
          {stripe === undefined ? (
            <p
              role="status"
              aria-busy="true"
              style={{ textAlign: 'center', color: 'var(--ut-color-ink)' }}
            >
              Chargement de Stripe…
            </p>
          ) : stripe === null ? (
            <p role="alert" style={errorStyle}>
              Configuration de paiement indisponible.
            </p>
          ) : clientSecret ? (
            <Elements
              stripe={stripe}
              options={{
                clientSecret,
                appearance: getPaymentAppearance(),
                fonts: getEmbeddedFonts(),
              }}
            >
              <PaymentForm
                totalLabel={totalLabel}
                holdDeadlineMs={deadlineMs}
                isExpired={isExpired}
                onSuccess={() => setPhase('success')}
                onError={(msg) => {
                  setErrorMessage(msg);
                  setPhase('error');
                }}
              />
            </Elements>
          ) : null}
        </>
      )}
    </section>
  );
}

const formStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1.25rem',
};

const cardStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1.25rem',
  backgroundColor: 'var(--ut-color-surface)',
  border: '1px solid var(--ut-color-border)',
  borderRadius: '0.5rem',
  padding: '1.5rem',
  boxShadow: 'var(--ut-shadow-sm)',
};

const summaryBoxStyle: React.CSSProperties = {
  padding: '1rem',
  backgroundColor: 'var(--ut-color-surface-raised)',
  border: '1px solid var(--ut-color-border)',
  borderRadius: '0.375rem',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const submitButtonStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.75rem 1rem',
  fontSize: '1rem',
  fontWeight: 'var(--ut-weight-semibold)',
  color: 'var(--ut-color-surface)',
  backgroundColor: 'var(--ut-color-primary)',
  border: 'none',
  borderRadius: '0.375rem',
  cursor: 'pointer',
};

const errorStyle: React.CSSProperties = {
  color: 'var(--ut-color-danger)',
  margin: 0,
  fontSize: '0.875rem',
  outline: 'none',
};

const visuallyHiddenStyle: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};
