'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { MerchantFinanceOverview, PayoutAccountStatus } from '@uttily/core';
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

interface FinancesHubProps {
  organizationId: string;
  status: PayoutAccountStatus;
  overview: MerchantFinanceOverview;
}

export function FinancesHub({
  organizationId,
  status,
  overview,
}: FinancesHubProps): React.ReactElement {
  const [filterType, setFilterType] = useState<'ALL' | 'PAYMENTS' | 'REFUNDS' | 'PAYOUTS'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [showBankSettings, setShowBankSettings] = useState(!status.isReady);

  // State pour l'onboarding bancaire embedded
  const [country, setCountry] = useState<string>('FR');
  const [isEmbeddedActive, setIsEmbeddedActive] = useState(false);
  const [companyName, setCompanyName] = useState('');
  const [siren, setSiren] = useState('');
  const [repName, setRepName] = useState('');
  const [iban, setIban] = useState('');
  const [bic, setBic] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Filtrage local interactif
  const filteredActivity = overview.activity.filter((item) => {
    if (filterType === 'PAYMENTS' && item.type !== 'PAYMENT') return false;
    if (filterType === 'REFUNDS' && item.type !== 'REFUND') return false;
    if (filterType === 'PAYOUTS' && item.type !== 'PAYOUT') return false;

    if (searchQuery.trim().length > 0) {
      const q = searchQuery.toLowerCase().trim();
      const matchRef = item.bookingReference.toLowerCase().includes(q);
      const matchProd = item.productName?.toLowerCase().includes(q) ?? false;
      const matchClient = item.customerEmail?.toLowerCase().includes(q) ?? false;
      if (!matchRef && !matchProd && !matchClient) return false;
    }

    return true;
  });

  // Gestion de l'onboarding bancaire
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

      await createAccountSessionAction(organizationId);
      setIsEmbeddedActive(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Erreur lors de l’ouverture de l’espace bancaire.',
      );
    } finally {
      setIsLoading(false);
    }
  }

  async function handleCompleteEmbeddedOnboarding(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      await completeEmbeddedOnboardingSimulationAction(organizationId);
      setSuccessMsg('Vos coordonnées bancaires ont été enregistrées et validées avec succès !');
      setIsEmbeddedActive(false);
      window.location.reload();
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

  function formatEur(minor: number): string {
    const absVal = Math.abs(minor) / 100;
    const sign = minor < 0 ? '-' : '';
    return `${sign}${absVal.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
  }

  return (
    <div className={styles.container}>
      {/* En-tête de la page */}
      <div className={styles.headerRow}>
        <div>
          <h1 className={styles.pageTitle}>💰 Revenus &amp; Versements</h1>
          <p className={styles.pageSubtitle}>
            Période : <strong>{overview.period.label}</strong> · Suivi en temps réel de vos
            encaissements, commissions et virements bancaires.
          </p>
        </div>

        <div className={styles.headerActions}>
          <a
            href={`/api/dashboard/${organizationId}/finances/export-csv`}
            download
            className={styles.btnExportCsv}
          >
            📥 Exporter en CSV
          </a>
        </div>
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

      {/* 4 Chiffres Clés Financiers */}
      <div className={styles.statsGrid}>
        <div className={`${styles.statCard} ${styles.statCardHighlight}`}>
          <span className={styles.statLabel}>Revenus après commission Uttily</span>
          <span className={styles.statNumberPrimary}>
            {formatEur(overview.merchant.netAfterCommissionMinor)}
          </span>
          <span className={styles.statSubText}>
            Sur {overview.sales.bookingCount} réservation
            {overview.sales.bookingCount > 1 ? 's' : ''} encaissée
            {overview.sales.bookingCount > 1 ? 's' : ''}
          </span>
        </div>

        <div className={styles.statCard}>
          <span className={styles.statLabel}>En attente d'encaissement</span>
          <span className={`${styles.statNumber} ${styles.statAmber}`}>
            {formatEur(overview.payments.pendingAmountMinor)}
          </span>
          <span className={styles.statSubText}>Paiements en cours de confirmation</span>
        </div>

        <div className={styles.statCard}>
          <span className={styles.statLabel}>Commission Uttily (Plateforme)</span>
          <span className={`${styles.statNumber} ${styles.statBlue}`}>
            {formatEur(overview.commissions.platformAmountMinor)}
          </span>
          <span className={styles.statSubText}>Frais de service &amp; passerelle bancaire</span>
        </div>

        <div className={styles.statCard}>
          <span className={styles.statLabel}>Remboursements</span>
          <span className={`${styles.statNumber} ${styles.statRed}`}>
            {formatEur(overview.payments.refundedAmountMinor)}
          </span>
          <span className={styles.statSubText}>Remboursements clients sur la période</span>
        </div>
      </div>

      {/* Section Synthèse Versements Bancaires (Payouts) */}
      <section className={styles.payoutsSection} aria-labelledby="payouts-section-title">
        <div className={styles.payoutsHeader}>
          <div>
            <h2 id="payouts-section-title" className={styles.payoutsTitle}>
              <span>🏦</span> Versements sur votre compte bancaire
            </h2>
            <span className={styles.payoutsSubtitle}>
              {status.isReady
                ? '🟢 Compte de versement bancaire actif et vérifié'
                : '⚠️ Configuration de votre compte bancaire requise'}
            </span>
          </div>

          <button
            type="button"
            onClick={() => setShowBankSettings(!showBankSettings)}
            className={styles.btnToggleSettings}
          >
            {showBankSettings ? '▲ Masquer les paramètres' : '⚙️ Gérer le compte bancaire'}
          </button>
        </div>

        <div className={styles.payoutsMetricsGrid}>
          <div className={styles.payoutMetric}>
            <span className={styles.payoutMetricLabel}>Dernier versement reçu :</span>
            <strong className={styles.payoutMetricValue}>
              {overview.payouts.lastPayout
                ? `${formatEur(overview.payouts.lastPayout.amountMinor)} · le ${new Date(overview.payouts.lastPayout.arrivalDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}`
                : 'Aucun versement récent'}
            </strong>
          </div>

          <div className={styles.payoutMetric}>
            <span className={styles.payoutMetricLabel}>En cours de transfert vers l'IBAN :</span>
            <strong className={styles.payoutMetricValue}>
              {formatEur(overview.payouts.inTransitAmountMinor)}
            </strong>
          </div>

          <div className={styles.payoutMetric}>
            <span className={styles.payoutMetricLabel}>Calendrier de versement :</span>
            <strong className={styles.payoutMetricValue}>
              {overview.payouts.nextPayoutSchedule}
            </strong>
          </div>
        </div>

        {/* Formulaire de coordonnées bancaires déroulable */}
        {showBankSettings && (
          <div className={styles.bankDrawer}>
            {!isEmbeddedActive ? (
              <div className={styles.bankStatusBox}>
                <p style={{ margin: 0, fontSize: '0.9rem', color: '#475569' }}>
                  {status.description}
                </p>
                {status.readiness === 'NOT_STARTED' && (
                  <div style={{ marginTop: '12px', display: 'flex', gap: '10px' }}>
                    <select
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
                      {isLoading ? 'Initialisation…' : 'Activer mes versements →'}
                    </button>
                  </div>
                )}

                {status.isReady && (
                  <button
                    type="button"
                    onClick={handleStartEmbeddedSession}
                    disabled={isLoading}
                    className={styles.btnSecondary}
                    style={{ marginTop: '12px' }}
                  >
                    {isLoading ? 'Chargement…' : 'Modifier mes coordonnées bancaires (IBAN)'}
                  </button>
                )}
              </div>
            ) : (
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
                    Représentant légal (Prénom &amp; Nom) :
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
                    Portail de secours ↗
                  </button>

                  <button type="submit" disabled={isLoading} className={styles.btnPrimary}>
                    {isLoading ? 'Enregistrement…' : 'Valider mes coordonnées bancaires ✓'}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </section>

      {/* Section Activité & Détail Financier */}
      <section className={styles.activitySection} aria-labelledby="activity-section-title">
        <div className={styles.activityHeaderRow}>
          <div>
            <h2 id="activity-section-title" className={styles.activityTitle}>
              📋 Activité &amp; Historique financier
            </h2>
            <span className={styles.activitySubtitle}>
              {filteredActivity.length} mouvement{filteredActivity.length > 1 ? 's' : ''} sur la
              période
            </span>
          </div>

          <div className={styles.filterControls}>
            {/* Recherche */}
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Rechercher (#UT-1042, client, vélo…)"
              className={styles.searchInput}
            />

            {/* Type */}
            <div className={styles.typeFilterToggle}>
              <button
                type="button"
                className={`${styles.typeBtn} ${filterType === 'ALL' ? styles.typeBtnActive : ''}`}
                onClick={() => setFilterType('ALL')}
              >
                Tout
              </button>
              <button
                type="button"
                className={`${styles.typeBtn} ${filterType === 'PAYMENTS' ? styles.typeBtnActive : ''}`}
                onClick={() => setFilterType('PAYMENTS')}
              >
                Paiements
              </button>
              <button
                type="button"
                className={`${styles.typeBtn} ${filterType === 'REFUNDS' ? styles.typeBtnActive : ''}`}
                onClick={() => setFilterType('REFUNDS')}
              >
                Remboursements
              </button>
              <button
                type="button"
                className={`${styles.typeBtn} ${filterType === 'PAYOUTS' ? styles.typeBtnActive : ''}`}
                onClick={() => setFilterType('PAYOUTS')}
              >
                Versements
              </button>
            </div>
          </div>
        </div>

        {/* Tableau Financier */}
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Référence &amp; Produit</th>
                <th>Client</th>
                <th>Montant Brut</th>
                <th>Commission Uttily</th>
                <th>Revenus Nets</th>
                <th>Paiement</th>
                <th>Versement</th>
              </tr>
            </thead>
            <tbody>
              {filteredActivity.length === 0 ? (
                <tr>
                  <td colSpan={8} className={styles.emptyTable}>
                    Aucune transaction financière trouvée pour ces critères.
                  </td>
                </tr>
              ) : (
                filteredActivity.map((item) => (
                  <tr key={item.id}>
                    <td className={styles.dateCell}>
                      {new Date(item.date).toLocaleDateString('fr-FR', {
                        day: 'numeric',
                        month: 'short',
                      })}
                      <span className={styles.timeSub}>
                        {new Date(item.date).toLocaleTimeString('fr-FR', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </td>

                    <td className={styles.refCell}>
                      {item.bookingId ? (
                        <Link
                          href={`/dashboard/${organizationId}/bookings/${item.bookingId}`}
                          className={styles.bookingLink}
                        >
                          {item.bookingReference} →
                        </Link>
                      ) : (
                        <span className={styles.refBadge}>{item.bookingReference}</span>
                      )}
                      <span className={styles.productNameSub}>{item.productName}</span>
                    </td>

                    <td className={styles.clientCell}>{item.customerEmail ?? '—'}</td>

                    <td className={styles.amountCell}>{formatEur(item.grossAmountMinor)}</td>

                    <td className={styles.commCell}>
                      {item.commissionAmountMinor > 0
                        ? `-${formatEur(item.commissionAmountMinor)}`
                        : '—'}
                    </td>

                    <td className={styles.netCell}>
                      <strong>{formatEur(item.netAmountMinor)}</strong>
                    </td>

                    <td>
                      <span
                        className={`${styles.statusBadge} ${
                          item.status === 'SUCCEEDED' ? styles.badgeSuccess : styles.badgePending
                        }`}
                      >
                        {item.statusLabel}
                      </span>
                    </td>

                    <td>
                      <span
                        className={`${styles.statusBadge} ${
                          item.payoutStatus === 'PAID'
                            ? styles.badgeSuccess
                            : item.payoutStatus === 'IN_TRANSIT'
                              ? styles.badgeInTransit
                              : styles.badgeMuted
                        }`}
                      >
                        {item.payoutStatus === 'PAID'
                          ? '✓ Versé'
                          : item.payoutStatus === 'IN_TRANSIT'
                            ? '⏳ En cours'
                            : 'En attente'}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Note de réassurance */}
      <aside className={styles.securityNote}>
        <span style={{ fontSize: '1.25rem' }}>🔒</span>
        <div>
          <strong>Séquestre des fonds &amp; Sécurité bancaire</strong>
          <p style={{ margin: '4px 0 0 0' }}>
            Tous les paiements locataires sont sécurisés et séquestrés auprès de notre partenaire
            bancaire agréé. Vos revenus sont versés automatiquement sur votre compte dès le début de
            la location.
          </p>
        </div>
      </aside>
    </div>
  );
}
