'use client';

import { useState, useEffect, useCallback } from 'react';
import type { ReactElement, FormEvent } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { initiatePaymentAction } from '@/app/actions/payments';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DraftLine {
  variantId: string;
  quantity: number;
  lineTotalAmountMinor: number;
}

interface CheckoutClientProps {
  draftId: string;
  returnUrl: string;
  totalAmountMinor: number;
  currency: string;
  lines: DraftLine[];
  expiresAt: string | null;
}

type Phase = 'idle' | 'initiating' | 'elements' | 'confirming' | 'success' | 'error';

// ---------------------------------------------------------------------------
// Stripe.js singleton — chargé une seule fois pour toute la session.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Formatage des montants (unités mineures → affichage EUR).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// PaymentForm — vit à l'intérieur de <Elements>, utilise useStripe/useElements.
// ---------------------------------------------------------------------------

interface PaymentFormProps {
  clientSecret: string;
  returnUrl: string;
  totalLabel: string;
  onConfirming: () => void;
  onSuccess: () => void;
  onError: (message: string) => void;
}

function PaymentForm({
  clientSecret,
  returnUrl,
  totalLabel,
  onConfirming,
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
    onConfirming();

    const result = await stripe.confirmPayment({
      elements,
      clientSecret,
      confirmParams: {
        return_url: returnUrl,
      },
      redirect: 'if_required',
    });

    if (result.error) {
      const message = result.error.message ?? 'Erreur de paiement';
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
            ? 'Formulaire de paiement en cours de chargement'
            : submitting
              ? 'Traitement en cours'
              : `Payer ${totalLabel}`
        }
        style={submitButtonStyle}
      >
        {!stripe
          ? 'Chargement du paiement...'
          : !paymentElementReady || !paymentElementMounted
            ? 'Préparation du paiement...'
            : submitting
              ? 'Traitement…'
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

// ---------------------------------------------------------------------------
// CheckoutClient — orchestre les deux phases (initiation puis confirmation).
// ---------------------------------------------------------------------------

export function CheckoutClient({
  draftId,
  returnUrl,
  totalAmountMinor,
  currency,
  lines,
  expiresAt,
}: CheckoutClientProps): ReactElement {
  const [phase, setPhase] = useState<Phase>('idle');
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  // stripe : undefined = chargement en cours, null = clé manquante, Stripe = prêt.
  const [stripe, setStripe] = useState<Stripe | null | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);

  // Charger Stripe.js uniquement quand on entre en phase 'elements'.
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
        // Le clientSecret est éphémère : conservé uniquement en mémoire,
        // jamais persisté ni loggé.
        setClientSecret(result.clientSecret);
        setPaymentId(result.paymentId);
        setPhase('elements');
      } else {
        setErrorMessage(result.message);
        setPhase('error');
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Erreur inattendue');
      setPhase('error');
    }
  }, [draftId]);

  const totalLabel = formatAmount(totalAmountMinor, currency);

  // --- Rendu selon la phase ---

  if (phase === 'success') {
    return (
      <section aria-labelledby="success-heading" style={sectionStyle}>
        <h2 id="success-heading">Paiement soumis</h2>
        <p>
          La confirmation de votre réservation est en cours. Vous serez redirigé vers votre
          réservation une fois le paiement confirmé.
        </p>
        {paymentId && (
          <p style={mutedStyle}>
            Référence paiement : <code>{paymentId}</code>
          </p>
        )}
      </section>
    );
  }

  if (phase === 'error') {
    return (
      <section aria-labelledby="error-heading" style={sectionStyle}>
        <h2 id="error-heading">Erreur</h2>
        <p role="alert" style={errorStyle}>
          {errorMessage ?? 'Une erreur est survenue.'}
        </p>
        <button type="button" onClick={handleInitiate} style={submitButtonStyle}>
          Réessayer
        </button>
      </section>
    );
  }

  return (
    <section aria-labelledby="checkout-heading" style={sectionStyle}>
      <h2 id="checkout-heading" style={visuallyHiddenStyle}>
        Récapitulatif et paiement
      </h2>

      {/* Récapitulatif de la réservation */}
      <div style={summaryStyle}>
        <h3>Récapitulatif</h3>
        <ul style={listStyle}>
          {lines.map((line) => (
            <li key={line.variantId} style={listItemStyle}>
              <span>
                Article ({line.variantId.slice(0, 8)}) × {line.quantity}
              </span>
              <span>{formatAmount(line.lineTotalAmountMinor, currency)}</span>
            </li>
          ))}
        </ul>
        <div style={totalRowStyle}>
          <span>Total</span>
          <strong>{totalLabel}</strong>
        </div>
        {expiresAt && (
          <p style={mutedStyle}>
            Brouillon valable jusqu'au{' '}
            {new Intl.DateTimeFormat('fr-FR', {
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(new Date(expiresAt))}
          </p>
        )}
      </div>

      {/* Phase 1 : bouton d'initiation du paiement */}
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
        <p aria-busy="true" role="status">
          Préparation du paiement…
        </p>
      )}

      {/* Phase 2 : Stripe Payment Element */}
      {phase === 'elements' && (
        <>
          {stripe === undefined ? (
            <p role="status" aria-busy="true">
              Chargement de Stripe…
            </p>
          ) : stripe === null ? (
            <p role="alert">Clé Stripe manquante — vérifiez NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.</p>
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
        <p role="status" aria-busy="true">
          Confirmation du paiement…
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Styles inline (pas de Tailwind) — mobile-first.
// ---------------------------------------------------------------------------

const formStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
};

const sectionStyle: React.CSSProperties = {
  maxWidth: 480,
  margin: '0 auto',
  padding: '1rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
};

const summaryStyle: React.CSSProperties = {
  padding: '1rem',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  background: '#f9fafb',
};

const listStyle: React.CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: '0 0 0.75rem 0',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
};

const listItemStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  fontSize: '0.95rem',
};

const totalRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  paddingTop: '0.75rem',
  borderTop: '1px solid #e5e7eb',
  fontSize: '1.1rem',
};

const submitButtonStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.875rem 1rem',
  fontSize: '1rem',
  fontWeight: 600,
  color: '#fff',
  background: '#2563eb',
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
};

const errorStyle: React.CSSProperties = {
  color: '#dc2626',
  margin: 0,
};

const mutedStyle: React.CSSProperties = {
  color: '#6b7280',
  fontSize: '0.85rem',
  margin: 0,
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
