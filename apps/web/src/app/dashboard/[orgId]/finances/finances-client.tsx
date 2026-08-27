'use client';

import { useState } from 'react';
import type { ConnectedAccountReadiness } from '@uttily/core';
import { resolvePayoutAccountStatus } from '@uttily/core';
import {
  createConnectedAccountAction,
  createOnboardingLinkAction,
} from '@/app/actions/connected-accounts';
import styles from './finances.module.css';

const SUPPORTED_COUNTRIES = [
  { code: 'FR', label: 'France (EUR)' },
  { code: 'BE', label: 'Belgique (EUR)' },
  { code: 'DE', label: 'Allemagne (EUR)' },
  { code: 'ES', label: 'Espagne (EUR)' },
  { code: 'IT', label: 'Italie (EUR)' },
  { code: 'NL', label: 'Pays-Bas (EUR)' },
] as const;

export function FinancesClient({
  organizationId,
  readiness,
}: {
  organizationId: string;
  readiness: ConnectedAccountReadiness;
}): React.ReactElement {
  const [country, setCountry] = useState<string>('FR');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const status = resolvePayoutAccountStatus(readiness);

  async function handleStartSetup(): Promise<void> {
    setError(null);
    setIsLoading(true);
    try {
      // 1. Crée le compte de versement
      await createConnectedAccountAction(organizationId, {
        country,
        idempotencyKey: crypto.randomUUID(),
      });

      // 2. Génère le lien de configuration bancaire sécurisé
      const result = await createOnboardingLinkAction(organizationId, {
        idempotencyKey: crypto.randomUUID(),
        origin: window.location.origin,
      });

      // 3. Redirige vers la session de saisie bancaire sécurisée
      window.location.href = result.url;
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Erreur lors de la configuration de vos versements.',
      );
      setIsLoading(false);
    }
  }

  async function handleResumeSetup(): Promise<void> {
    setError(null);
    setIsLoading(true);
    try {
      const result = await createOnboardingLinkAction(organizationId, {
        idempotencyKey: crypto.randomUUID(),
        origin: window.location.origin,
      });
      window.location.href = result.url;
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Erreur lors de l’accès à la gestion de vos coordonnées bancaires.',
      );
      setIsLoading(false);
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.headerRow}>
        <h1 className={styles.pageTitle}>💰 Mes Revenus & Versements</h1>
        <p className={styles.pageSubtitle}>
          Gestion de votre compte de versement bancaire et suivi des revenus de location.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            padding: '12px 16px',
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: '12px',
            color: '#b91c1c',
            fontSize: '0.9rem',
          }}
        >
          {error}
        </div>
      )}

      {/* Carte d'état principale */}
      <section
        className={`${styles.statusCard} ${
          status.isReady
            ? styles.statusCardEnabled
            : status.readiness === 'PENDING_VERIFICATION'
              ? styles.statusCardPending
              : ''
        }`}
        aria-labelledby="payout-status-title"
      >
        <div className={styles.cardHeader}>
          <h2 id="payout-status-title" className={styles.statusLabel}>
            <span>
              {status.isReady ? '🟢' : status.readiness === 'PENDING_VERIFICATION' ? '⏳' : '💳'}
            </span>
            {status.label}
          </h2>

          {status.isReady ? (
            <span className={styles.badgeEnabled}>✓ Opérationnel</span>
          ) : status.readiness === 'PENDING_VERIFICATION' ? (
            <span className={styles.badgePending}>En cours de validation</span>
          ) : (
            <span className={styles.badgePending}>Configuration requise</span>
          )}
        </div>

        <p className={styles.statusDesc}>{status.description}</p>

        {/* Action selon le statut */}
        {status.readiness === 'NOT_STARTED' && (
          <div className={styles.formSection}>
            <label htmlFor="country-select" className={styles.formLabel}>
              Pays de votre compte bancaire professionnel :
            </label>
            <select
              id="country-select"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className={styles.selectInput}
              disabled={isLoading}
            >
              {SUPPORTED_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={handleStartSetup}
              disabled={isLoading}
              className={styles.btnPrimary}
            >
              {isLoading ? 'Ouverture de l’espace sécurisé…' : 'Activer mes versements bancaires →'}
            </button>
          </div>
        )}

        {status.readiness === 'ACTION_REQUIRED' && (
          <button
            type="button"
            onClick={handleResumeSetup}
            disabled={isLoading}
            className={styles.btnPrimary}
          >
            {isLoading
              ? 'Ouverture de l’espace sécurisé…'
              : 'Compléter mes informations bancaires →'}
          </button>
        )}

        {status.isReady && (
          <div>
            <button
              type="button"
              onClick={handleResumeSetup}
              disabled={isLoading}
              className={styles.btnSecondary}
            >
              {isLoading ? 'Chargement…' : 'Mettre à jour mes coordonnées bancaires'}
            </button>
          </div>
        )}
      </section>

      {/* Note de réassurance & sécurité */}
      <aside className={styles.securityNote}>
        <span style={{ fontSize: '1.25rem' }}>🔒</span>
        <div>
          <strong>Séquestre des fonds & Sécurité bancaire</strong>
          <p style={{ margin: '4px 0 0 0' }}>
            Tous les paiements locataires sont séquestrés auprès de notre établissement bancaire
            partenaire agréé en Europe. Vos revenus sont versés automatiquement sur votre IBAN dès
            que la location démarre.
          </p>
        </div>
      </aside>
    </div>
  );
}
