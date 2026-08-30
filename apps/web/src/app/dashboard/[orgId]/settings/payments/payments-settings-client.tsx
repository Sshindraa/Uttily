'use client';

import { useState, useTransition } from 'react';
import type { ConnectedAccountReadiness } from '@uttily/core';
import {
  createConnectedAccountAction,
  createOnboardingLinkAction,
} from '@/app/actions/connected-accounts';
import {
  DEFAULT_STRIPE_COUNTRY,
  STRIPE_SUPPORTED_COUNTRIES,
} from '@/lib/supported-stripe-countries';
import { StatusCard } from './status-card';

type ActionMode = 'create' | 'onboard' | null;

/**
 * Composant client des paramètres de paiement Stripe Connect.
 *
 * Toutes les mutations passent par des Server Actions qui re-valident
 * l'autorisation côté serveur. L'organizationId provient du paramètre de
 * route (validé par le layout) et n'est jamais trusté depuis le client.
 */
export function PaymentsSettingsClient({
  organizationId,
  readiness,
}: {
  organizationId: string;
  readiness: ConnectedAccountReadiness;
}): React.ReactElement {
  const [country, setCountry] = useState<string>(DEFAULT_STRIPE_COUNTRY);
  const [error, setError] = useState<string | null>(null);
  const [pendingMode, setPendingMode] = useState<ActionMode>(null);
  const [transition, startTransition] = useTransition();

  const onboardingStatus = readiness.onboardingStatus;

  async function handleCreateAccount(): Promise<void> {
    setError(null);
    setPendingMode('create');
    try {
      await createConnectedAccountAction(organizationId, {
        country,
        idempotencyKey: crypto.randomUUID(),
      });
      // Recharger pour refléter le nouveau compte (la Server Action a appelé
      // revalidatePath).
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur lors de la création du compte.');
      setPendingMode(null);
    }
  }

  async function handleResumeOnboarding(): Promise<void> {
    setError(null);
    setPendingMode('onboard');
    try {
      const result = await createOnboardingLinkAction(organizationId, {
        idempotencyKey: crypto.randomUUID(),
        origin: window.location.origin,
      });
      // Rediriger vers l'URL Stripe-hosted.
      window.location.href = result.url;
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Erreur lors de la génération du lien d'onboarding.",
      );
      setPendingMode(null);
    }
  }

  const isPending = transition || pendingMode !== null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <StatusCard readiness={readiness} />

      {error && (
        <p role="alert" aria-live="assertive" style={{ color: '#dc2626' }}>
          {error}
        </p>
      )}

      {readiness.notConfigured && (
        <section aria-labelledby="setup-title">
          <h2 id="setup-title">Configurer Stripe</h2>
          <p>
            Aucun compte de paiement n'est encore configuré. Crée un compte Stripe Connect pour
            pouvoir encaisser des paiements.
          </p>

          <label htmlFor="country">Pays du compte</label>
          <select
            id="country"
            name="country"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            disabled={isPending}
            style={{ display: 'block', margin: '0.25rem 0 1rem', maxWidth: '20rem' }}
          >
            {STRIPE_SUPPORTED_COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => startTransition(handleCreateAccount)}
            disabled={isPending}
            aria-busy={pendingMode === 'create'}
            style={{ width: '100%', maxWidth: '20rem', padding: '0.75rem' }}
          >
            {pendingMode === 'create' ? 'Création…' : 'Configurer Stripe'}
          </button>
        </section>
      )}

      {!readiness.notConfigured &&
        (onboardingStatus === 'PENDING' || onboardingStatus === 'SUBMITTED') && (
          <section aria-labelledby="onboarding-title">
            <h2 id="onboarding-title">Onboarding en cours</h2>
            <p>
              L'onboarding Stripe n'est pas terminé. Reprends le parcours hébergé par Stripe pour
              compléter les informations requises.
            </p>
            <button
              type="button"
              onClick={() => startTransition(handleResumeOnboarding)}
              disabled={isPending}
              aria-busy={pendingMode === 'onboard'}
              style={{ width: '100%', maxWidth: '20rem', padding: '0.75rem' }}
            >
              {pendingMode === 'onboard' ? 'Redirection…' : "Reprendre l'onboarding"}
            </button>
          </section>
        )}

      {!readiness.notConfigured && onboardingStatus === 'ENABLED' && (
        <section aria-labelledby="active-title">
          <h2 id="active-title">Compte actif</h2>
          <p role="status">
            Ton compte Stripe Connect est actif. Tu peux encaisser des paiements et recevoir des
            virements.
          </p>
          <ul style={{ listStyle: 'none', padding: 0 }}>
            <li>Charges : {readiness.chargesEnabled ? 'activées' : 'désactivées'}</li>
            <li>Payouts : {readiness.payoutsEnabled ? 'activés' : 'désactivés'}</li>
            <li>Transfers : {readiness.transfersCapabilityStatus ?? 'inconnu'}</li>
          </ul>
        </section>
      )}

      {!readiness.notConfigured &&
        (onboardingStatus === 'DISABLED' || onboardingStatus === 'REJECTED') && (
          <section aria-labelledby="error-title">
            <h2 id="error-title" style={{ color: '#dc2626' }}>
              Compte indisponible
            </h2>
            <p role="alert">
              Le compte Stripe Connect est{' '}
              {onboardingStatus === 'REJECTED' ? 'rejeté' : 'désactivé'}. Contacte le support pour
              reprendre l'onboarding ou résoudre le problème.
            </p>
            <button
              type="button"
              onClick={() => startTransition(handleResumeOnboarding)}
              disabled={isPending}
              aria-busy={pendingMode === 'onboard'}
              style={{ width: '100%', maxWidth: '20rem', padding: '0.75rem' }}
            >
              {pendingMode === 'onboard' ? 'Redirection…' : "Reprendre l'onboarding"}
            </button>
          </section>
        )}
    </div>
  );
}
