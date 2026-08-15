'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { ReactElement, FormEvent } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { initiateSupplementPaymentAction } from '@/app/actions/booking-amendments';

export interface SupplementCheckoutClientProps {
  amendmentId: string;
  amountMinor: number;
  currency: string;
  holdDeadline: string;
  timeZone: string;
}

type Phase = 'idle' | 'initiating' | 'elements' | 'confirming' | 'success' | 'error';

let stripePromise: Promise<Stripe | null> | null = null;

function getStripePromise(): Promise<Stripe | null> {
  if (!stripePromise) {
    const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    if (!publishableKey) {
      stripePromise = Promise.resolve(null);
    } else {
      stripePromise = loadStripe(publishableKey);
    }
  }
  return stripePromise;
}

function formatAmount(minor: number, currency: string): string {
  const value = minor / 100;
  try {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function formatHoldDeadline(isoString: string, timeZone: string): string {
  try {
    const d = new Date(isoString);
    return new Intl.DateTimeFormat('fr-FR', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: '2-digit',
    }).format(d);
  } catch {
    return isoString;
  }
}

interface PaymentFormProps {
  totalLabel: string;
  onConfirming: () => void;
  onSuccess: () => void;
  onError: (message: string) => void;
}

function PaymentForm({
  totalLabel,
  onConfirming,
  onSuccess,
  onError,
}: PaymentFormProps): ReactElement {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);
    onConfirming();

    const result = await stripe.confirmPayment({
      elements,
      redirect: 'if_required',
    });

    if (result.error) {
      const message = result.error.message ?? 'Erreur lors du paiement.';
      setError(message);
      onError(message);
      setSubmitting(false);
    } else {
      onSuccess();
    }
  }

  return (
    <form onSubmit={handleSubmit} style={formStyle} data-testid="supplement-payment-form">
      <PaymentElement
        options={{
          layout: { type: 'accordion', defaultCollapsed: false, radios: true },
        }}
      />
      <button
        type="submit"
        disabled={!stripe || submitting}
        aria-busy={submitting}
        style={submitButtonStyle}
        data-testid="supplement-submit-payment-button"
      >
        {submitting ? 'Traitement en cours…' : `Payer ${totalLabel}`}
      </button>
      {error && (
        <p role="alert" style={errorStyle} data-testid="supplement-payment-error">
          {error}
        </p>
      )}
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
  const [phase, setPhase] = useState<Phase>('idle');
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [stripe, setStripe] = useState<Stripe | null | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const errorRef = useRef<HTMLParagraphElement>(null);
  const successRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (phase === 'elements' && stripe === undefined) {
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

  const handleInitiate = useCallback(async () => {
    setPhase('initiating');
    setErrorMessage(null);
    try {
      const result = await initiateSupplementPaymentAction({ amendmentId });
      if (result.kind === 'READY') {
        setClientSecret(result.clientSecret);
        setPhase('elements');
      } else {
        setErrorMessage(result.message);
        setPhase('error');
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : 'Une erreur temporaire est survenue. Veuillez réessayer.',
      );
      setPhase('error');
    }
  }, [amendmentId]);

  const totalLabel = formatAmount(amountMinor, currency);
  const formattedDeadline = formatHoldDeadline(holdDeadline, timeZone);

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
              backgroundColor: '#ecfdf5',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#059669',
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
              style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0, outline: 'none' }}
            >
              Paiement soumis
            </h2>
          </div>
        </div>
        <p style={{ margin: 0, color: '#166534', fontSize: '0.95rem', lineHeight: 1.5 }}>
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
        <h2 id="error-heading" style={{ fontSize: '1.25rem', margin: 0, color: '#b91c1c' }}>
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
          <span style={{ color: '#4b5563' }}>Montant du supplément</span>
          <strong style={{ fontSize: '1.25rem', color: '#111827' }}>{totalLabel}</strong>
        </div>
        <div style={{ ...rowStyle, marginTop: '0.75rem', fontSize: '0.875rem', color: '#6b7280' }}>
          <span>Échéance de réservation</span>
          <span>
            Avant {formattedDeadline} ({timeZone})
          </span>
        </div>
      </div>

      {phase === 'idle' && (
        <button
          type="button"
          onClick={handleInitiate}
          style={submitButtonStyle}
          data-testid="supplement-initiate-button"
        >
          Payer {totalLabel}
        </button>
      )}

      {phase === 'initiating' && (
        <p aria-busy="true" role="status" style={{ textAlign: 'center', color: '#4b5563' }}>
          Préparation du paiement sécurisé…
        </p>
      )}

      {phase === 'elements' && (
        <>
          {stripe === undefined ? (
            <p role="status" aria-busy="true" style={{ textAlign: 'center', color: '#4b5563' }}>
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
                appearance: { theme: 'stripe' },
              }}
            >
              <PaymentForm
                totalLabel={totalLabel}
                onConfirming={() => setPhase('confirming')}
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

      {phase === 'confirming' && (
        <p role="status" aria-busy="true" style={{ textAlign: 'center', color: '#4b5563' }}>
          Validation du paiement en cours…
        </p>
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
  backgroundColor: '#ffffff',
  border: '1px solid #e5e7eb',
  borderRadius: '0.5rem',
  padding: '1.5rem',
  boxShadow: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
};

const summaryBoxStyle: React.CSSProperties = {
  padding: '1rem',
  backgroundColor: '#f9fafb',
  border: '1px solid #e5e7eb',
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
  fontWeight: 600,
  color: '#ffffff',
  backgroundColor: '#2563eb',
  border: 'none',
  borderRadius: '0.375rem',
  cursor: 'pointer',
};

const errorStyle: React.CSSProperties = {
  color: '#b91c1c',
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
