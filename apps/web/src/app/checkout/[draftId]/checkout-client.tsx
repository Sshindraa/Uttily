'use client';

import { useState, useEffect, useCallback } from 'react';
import type { ReactElement, FormEvent, CSSProperties } from 'react';
import Link from 'next/link';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { initiatePaymentAction } from '@/app/actions/payments';

interface DraftLine {
  variantId: string;
  quantity: number;
  lineTotalAmountMinor: number;
  title: string;
}

interface CheckoutClientProps {
  draftId: string;
  returnUrl: string;
  baseAmountMinor: number;
  customerServiceFeeAmountMinor: number;
  customerTotalAmountMinor: number;
  hasMarketplaceFeeSnapshot: boolean;
  currency: string;
  lines: DraftLine[];
  renterName: string;
  expiresAt: string | null;
}

type Phase = 'idle' | 'initiating' | 'elements' | 'success' | 'error';

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

interface PaymentFormProps {
  clientSecret: string;
  returnUrl: string;
  totalLabel: string;
  onSuccess: () => void;
  onError: (message: string) => void;
}

function PaymentForm({
  clientSecret,
  returnUrl,
  totalLabel,
  onSuccess,
  onError,
}: PaymentFormProps): ReactElement {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [paymentElementReady, setPaymentElementReady] = useState(false);
  const [paymentElementMounted, setPaymentElementMounted] = useState(false);
  const handlePaymentReady = useCallback(() => setPaymentElementReady(true), []);

  useEffect(() => {
    if (!elements || !paymentElementReady) return;
    if (elements.getElement('payment')) {
      setPaymentElementMounted(true);
    }
  }, [elements, paymentElementReady]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!stripe || !elements) return;
    const paymentEl = elements.getElement('payment');
    if (!paymentEl) {
      const message = "Le formulaire de paiement n'est pas encore initialisé.";
      setError(message);
      onError(message);
      return;
    }

    setSubmitting(true);
    setError(null);

    const submitResult = await elements.submit();
    if (submitResult.error) {
      const message =
        submitResult.error.message ?? 'Vérifiez les informations de paiement saisies.';
      setError(message);
      onError(message);
      setSubmitting(false);
      return;
    }

    const result = await stripe.confirmPayment({
      elements,
      clientSecret,
      confirmParams: {
        return_url: returnUrl,
      },
      redirect: 'if_required',
    });

    if (result.error) {
      const message = result.error.message ?? 'Le paiement n’a pas pu aboutir. Veuillez réessayer.';
      setError(message);
      onError(message);
      setSubmitting(false);
    } else {
      onSuccess();
    }
  }

  return (
    <form onSubmit={handleSubmit} style={formStyle}>
      <PaymentElement
        options={{
          layout: 'tabs',
        }}
        onReady={handlePaymentReady}
      />
      <button
        type="submit"
        disabled={!paymentElementMounted || !paymentElementReady || !stripe || submitting}
        aria-busy={!paymentElementMounted || !paymentElementReady || submitting}
        aria-label={
          !paymentElementReady || !paymentElementMounted
            ? 'Chargement du module de paiement'
            : submitting
              ? 'Paiement en cours...'
              : `Payer ${totalLabel}`
        }
        style={submitButtonStyle}
      >
        {!stripe
          ? 'Chargement du paiement...'
          : !paymentElementReady || !paymentElementMounted
            ? 'Préparation du paiement…'
            : submitting
              ? 'Traitement du paiement…'
              : `Payer ${totalLabel}`}
      </button>
      {(!paymentElementReady || !paymentElementMounted) && stripe && (
        <p role="status" aria-live="polite" style={mutedStyle}>
          Préparation du formulaire de paiement…
        </p>
      )}
      {error && (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      )}
    </form>
  );
}

export function CheckoutClient({
  draftId,
  returnUrl,
  baseAmountMinor,
  customerServiceFeeAmountMinor,
  customerTotalAmountMinor,
  hasMarketplaceFeeSnapshot,
  currency,
  lines,
  renterName,
  expiresAt,
}: CheckoutClientProps): ReactElement {
  const [phase, setPhase] = useState<Phase>('idle');
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [stripe, setStripe] = useState<Stripe | null | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

  const handleInitiate = useCallback(async () => {
    setPhase('initiating');
    setErrorMessage(null);
    try {
      const result = await initiatePaymentAction({
        draftId,
        idempotencyKey: crypto.randomUUID(),
        termsVersion: 'v1',
      });
      if (result.kind === 'SUCCESS' || result.kind === 'REPLAY') {
        setClientSecret(result.clientSecret);
        setPhase('elements');
      } else {
        setErrorMessage(result.message);
        setPhase('error');
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Une erreur inattendue est survenue.');
      setPhase('error');
    }
  }, [draftId]);

  const totalLabel = formatAmount(customerTotalAmountMinor, currency);

  if (phase === 'success') {
    return (
      <section aria-labelledby="success-heading" style={sectionStyle}>
        <div style={cardStyle}>
          <div style={successIconStyle}>✓</div>
          <h2
            id="success-heading"
            style={{
              fontSize: '1.5rem',
              fontWeight: 'bold',
              margin: '0 0 0.5rem 0',
              color: 'var(--ut-color-ink-strong)',
            }}
          >
            Paiement confirmé !
          </h2>
          <p style={{ color: 'var(--ut-color-ink-muted)', margin: 0 }}>
            Votre réservation chez <strong>{renterName}</strong> est validée. Retrouvez tous les
            détails et l’itinéraire dans votre espace.
          </p>
          <div style={{ marginTop: '1.5rem', width: '100%' }}>
            <Link
              href="/fr/account/bookings"
              style={{
                ...submitButtonStyle,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                textDecoration: 'none',
              }}
            >
              Accéder à mes locations →
            </Link>
          </div>
        </div>
      </section>
    );
  }

  if (phase === 'error') {
    return (
      <section aria-labelledby="error-heading" style={sectionStyle}>
        <div style={cardStyle}>
          <h2 id="error-heading" style={{ color: 'var(--ut-color-danger)', margin: 0 }}>
            Paiement interrompu
          </h2>
          <p role="alert" style={{ color: 'var(--ut-color-ink-muted)', margin: 0 }}>
            {errorMessage ?? 'Une erreur est survenue lors de l’initialisation de votre paiement.'}
          </p>
          <button type="button" onClick={handleInitiate} style={submitButtonStyle}>
            Réessayer le paiement
          </button>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="checkout-heading" style={sectionStyle}>
      <h2 id="checkout-heading" style={visuallyHiddenStyle}>
        Récapitulatif et paiement
      </h2>

      <div style={cardStyle}>
        <h3
          style={{
            margin: '0 0 0.75rem 0',
            fontSize: '1.1rem',
            color: 'var(--ut-color-ink-strong)',
          }}
        >
          Récapitulatif de votre équipement
        </h3>

        <ul style={listStyle}>
          {lines.map((line) => (
            <li key={line.variantId} style={listItemStyle}>
              <span>
                <strong>{line.title}</strong> × {line.quantity}
              </span>
              <strong style={{ color: 'var(--ut-color-ink-strong)' }}>
                {formatAmount(line.lineTotalAmountMinor, currency)}
              </strong>
            </li>
          ))}
        </ul>

        {hasMarketplaceFeeSnapshot ? (
          <div style={breakdownStyle}>
            <div style={breakdownRowStyle}>
              <span>Location</span>
              <span>{formatAmount(baseAmountMinor, currency)}</span>
            </div>
            <div style={breakdownRowStyle}>
              <span>Frais de service</span>
              <span>{formatAmount(customerServiceFeeAmountMinor, currency)}</span>
            </div>
            <div style={totalRowStyle}>
              <span>Total à régler</span>
              <strong style={{ color: 'var(--ut-color-primary)', fontSize: '1.25rem' }}>
                {totalLabel}
              </strong>
            </div>
          </div>
        ) : (
          <div style={totalRowStyle}>
            <span>Total à régler</span>
            <strong style={{ color: 'var(--ut-color-primary)', fontSize: '1.25rem' }}>
              {totalLabel}
            </strong>
          </div>
        )}

        {expiresAt && (
          <p style={mutedStyle}>
            Brouillon valide jusqu’au{' '}
            {new Intl.DateTimeFormat('fr-FR', {
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(new Date(expiresAt))}
          </p>
        )}
      </div>

      <div style={cardStyle}>
        {phase === 'idle' && (
          <button
            type="button"
            onClick={handleInitiate}
            style={submitButtonStyle}
            aria-label="Initier le paiement"
          >
            Payer {totalLabel}
          </button>
        )}

        {phase === 'initiating' && (
          <p
            aria-busy="true"
            role="status"
            style={{ textAlign: 'center', margin: 0, color: 'var(--ut-color-ink-muted)' }}
          >
            Préparation du paiement…
          </p>
        )}

        {phase === 'elements' && (
          <>
            {stripe === undefined ? (
              <p
                role="status"
                aria-busy="true"
                style={{ textAlign: 'center', color: 'var(--ut-color-ink-muted)' }}
              >
                Chargement du module de paiement…
              </p>
            ) : stripe === null ? (
              <p role="alert" style={errorStyle}>
                Le service de paiement est momentanément indisponible. Veuillez réessayer plus tard.
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
                  clientSecret={clientSecret}
                  returnUrl={returnUrl}
                  totalLabel={totalLabel}
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
      </div>
    </section>
  );
}

const formStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1.25rem',
};

const sectionStyle: CSSProperties = {
  maxWidth: 480,
  margin: '0 auto',
  padding: '1rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '1.5rem',
};

const cardStyle: CSSProperties = {
  padding: '1.5rem',
  border: 'var(--ut-border-thin)',
  borderRadius: 'var(--ut-radius-lg)',
  background: 'var(--ut-color-surface)',
  boxShadow: 'var(--ut-shadow-sm)',
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
};

const listStyle: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.65rem',
};

const listItemStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  fontSize: '0.95rem',
};

const totalRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  paddingTop: '0.75rem',
  borderTop: 'var(--ut-border-thin)',
  fontSize: '1.1rem',
  fontWeight: 'bold',
};

const breakdownStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
};

const breakdownRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  color: 'var(--ut-color-ink-muted)',
  fontSize: '0.95rem',
};

const submitButtonStyle: CSSProperties = {
  width: '100%',
  minHeight: '48px',
  padding: '0.75rem 1.25rem',
  fontSize: '1rem',
  fontWeight: 700,
  color: '#fff',
  background: 'var(--ut-color-accent)',
  border: 'none',
  borderRadius: 'var(--ut-radius-md)',
  cursor: 'pointer',
  transition: 'background var(--ut-motion-fast) var(--ut-ease-standard)',
};

const errorStyle: CSSProperties = {
  color: 'var(--ut-color-danger)',
  fontSize: '0.875rem',
  margin: 0,
};

const mutedStyle: CSSProperties = {
  color: 'var(--ut-color-ink-muted)',
  fontSize: '0.85rem',
  margin: 0,
};

const visuallyHiddenStyle: CSSProperties = {
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

const successIconStyle: CSSProperties = {
  width: 56,
  height: 56,
  borderRadius: '50%',
  background: 'var(--ut-color-success-soft)',
  color: 'var(--ut-color-success)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '1.75rem',
  margin: '0 auto',
};
