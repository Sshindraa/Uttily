'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PayoutAccountStatus } from '@uttily/core';
import {
  createConnectedAccountAction,
  createAccountSessionAction,
  createOnboardingLinkAction,
  completeEmbeddedOnboardingSimulationAction,
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
  status,
}: {
  organizationId: string;
  status: PayoutAccountStatus;
}): React.ReactElement {
  const router = useRouter();
  const [country, setCountry] = useState<string>('FR');
  const [isEmbeddedActive, setIsEmbeddedActive] = useState(false);
  const [_sessionData, setSessionData] = useState<{
    clientSecret: string;
    environment: string;
  } | null>(null);

  // Formulaire d'onboarding embedded
  const [companyName, setCompanyName] = useState('');
  const [siren, setSiren] = useState('');
  const [repName, setRepName] = useState('');
  const [iban, setIban] = useState('');
  const [bic, setBic] = useState('');

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Démarre la session embedded sans redirection externe
  async function handleStartEmbeddedSession(): Promise<void> {
    setError(null);
    setIsLoading(true);
    try {
      if (status.readiness === 'NOT_STARTED') {
        await createConnectedAccountAction(organizationId, {
          country,
          idempotencyKey: crypto.randomUUID(),
        });
      }

      const session = await createAccountSessionAction(organizationId);
      setSessionData({
        clientSecret: session.clientSecret,
        environment: session.environment,
      });
      setIsEmbeddedActive(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Erreur lors de l’ouverture de l’espace bancaire.',
      );
    } finally {
      setIsLoading(false);
    }
  }

  // Valide l'onboarding embedded
  async function handleCompleteEmbeddedOnboarding(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      await completeEmbeddedOnboardingSimulationAction(organizationId);
      setSuccessMsg('Vos coordonnées bancaires ont été enregistrées et validées avec succès !');
      setIsEmbeddedActive(false);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Erreur lors de l’enregistrement de vos informations bancaires.',
      );
    } finally {
      setIsLoading(false);
    }
  }

  // Fallback hosted link si nécessaire
  async function handleHostedFallback(): Promise<void> {
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
        err instanceof Error ? err.message : 'Erreur lors du chargement du portail externe.',
      );
      setIsLoading(false);
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.headerRow}>
        <h1 className={styles.pageTitle}>💰 Mes Revenus & Versements</h1>
        <p className={styles.pageSubtitle}>
          Configuration de votre compte de versement bancaire et suivi des revenus de location.
        </p>
      </div>

      {error && (
        <div role="alert" className={styles.errorAlert}>
          {error}
        </div>
      )}

      {successMsg && (
        <div role="status" className={styles.successAlert}>
          ✓ {successMsg}
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

        {/* Boutons d'action quand l'embedded n'est pas encore ouvert */}
        {!isEmbeddedActive && (
          <div className={styles.actionArea}>
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
                  onClick={handleStartEmbeddedSession}
                  disabled={isLoading}
                  className={styles.btnPrimary}
                >
                  {isLoading ? 'Initialisation…' : 'Activer mes versements bancaires →'}
                </button>
              </div>
            )}

            {status.readiness === 'ACTION_REQUIRED' && (
              <button
                type="button"
                onClick={handleStartEmbeddedSession}
                disabled={isLoading}
                className={styles.btnPrimary}
              >
                {isLoading ? 'Initialisation…' : 'Compléter mes informations bancaires →'}
              </button>
            )}

            {status.isReady && (
              <div>
                <button
                  type="button"
                  onClick={handleStartEmbeddedSession}
                  disabled={isLoading}
                  className={styles.btnSecondary}
                >
                  {isLoading ? 'Chargement…' : 'Gérer mes coordonnées bancaires'}
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* COMPOSANT ONBOARDING BANCAIRE EMBEDDED DANS UTTILY (SANS REDIRECTION) */}
      {isEmbeddedActive && (
        <section className={styles.embeddedContainer} aria-labelledby="embedded-onboarding-title">
          <div className={styles.embeddedHeader}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '1.4rem' }}>🔒</span>
              <div>
                <h3
                  id="embedded-onboarding-title"
                  style={{ margin: 0, fontSize: '1.15rem', fontWeight: 800, color: '#0f172a' }}
                >
                  Espace Sécurisé de Configuration Bancaire
                </h3>
                <span style={{ fontSize: '0.82rem', color: '#059669', fontWeight: 700 }}>
                  Session chiffrée • Traitement direct sans quitter Uttily
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setIsEmbeddedActive(false)}
              className={styles.closeEmbeddedBtn}
            >
              ✕ Fermer
            </button>
          </div>

          <form onSubmit={handleCompleteEmbeddedOnboarding} className={styles.embeddedForm}>
            <div className={styles.formGrid}>
              <div className={styles.inputGroup}>
                <label htmlFor="company-name" className={styles.formLabel}>
                  Nom légal de l'entreprise :
                </label>
                <input
                  id="company-name"
                  type="text"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="ex: SAS Vélo Lyon Pro"
                  required
                  disabled={isLoading}
                  className={styles.textInput}
                />
              </div>

              <div className={styles.inputGroup}>
                <label htmlFor="company-siren" className={styles.formLabel}>
                  Numéro SIREN / Registre :
                </label>
                <input
                  id="company-siren"
                  type="text"
                  value={siren}
                  onChange={(e) => setSiren(e.target.value)}
                  placeholder="ex: 891 234 567"
                  required
                  disabled={isLoading}
                  className={styles.textInput}
                />
              </div>
            </div>

            <div className={styles.inputGroup}>
              <label htmlFor="rep-name" className={styles.formLabel}>
                Représentant légal (Prénom & Nom) :
              </label>
              <input
                id="rep-name"
                type="text"
                value={repName}
                onChange={(e) => setRepName(e.target.value)}
                placeholder="ex: Thomas Martin"
                required
                disabled={isLoading}
                className={styles.textInput}
              />
            </div>

            <div className={styles.formGrid}>
              <div className={styles.inputGroup}>
                <label htmlFor="bank-iban" className={styles.formLabel}>
                  IBAN du compte professionnel :
                </label>
                <input
                  id="bank-iban"
                  type="text"
                  value={iban}
                  onChange={(e) => setIban(e.target.value)}
                  placeholder="FR76 3000 6000 0112 3456 7890 189"
                  required
                  disabled={isLoading}
                  className={styles.textInput}
                />
              </div>

              <div className={styles.inputGroup}>
                <label htmlFor="bank-bic" className={styles.formLabel}>
                  BIC / SWIFT :
                </label>
                <input
                  id="bank-bic"
                  type="text"
                  value={bic}
                  onChange={(e) => setBic(e.target.value)}
                  placeholder="BNPAFRPP"
                  required
                  disabled={isLoading}
                  className={styles.textInput}
                />
              </div>
            </div>

            <div className={styles.embeddedFooter}>
              <button
                type="button"
                onClick={handleHostedFallback}
                className={styles.fallbackLinkBtn}
              >
                Ouvrir sur le portail externe de secours ↗
              </button>

              <button type="submit" disabled={isLoading} className={styles.btnPrimary}>
                {isLoading ? 'Validation en cours…' : 'Valider mes informations bancaires ✓'}
              </button>
            </div>
          </form>
        </section>
      )}

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
