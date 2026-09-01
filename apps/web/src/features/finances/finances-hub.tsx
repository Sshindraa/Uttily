'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import type { MerchantFinanceOverview, PayoutAccountStatus, PayoutReadiness } from '@uttily/core';
import {
  ConnectComponentsProvider,
  ConnectAccountOnboarding,
  ConnectAccountManagement,
} from '@stripe/react-connect-js';
import { loadConnectAndInitialize, type StripeConnectInstance } from '@stripe/connect-js';
import {
  createConnectedAccountAction,
  createAccountSessionAction,
  createOnboardingLinkAction,
} from '@/app/actions/connected-accounts';
import { PageHeader, Card, Badge, Button, LinkButton } from '@uttily/ui';
import type { BadgeTone } from '@uttily/ui';
import { getEmbeddedColors, getEmbeddedFonts, UTTILY_FONT_FAMILY } from '@/lib/typography';
import {
  DEFAULT_STRIPE_COUNTRY,
  STRIPE_SUPPORTED_COUNTRIES,
} from '@/lib/supported-stripe-countries';

function getAccountBadgeTone(readiness: PayoutReadiness): BadgeTone {
  switch (readiness) {
    case 'ENABLED':
      return 'success';
    case 'ACTION_REQUIRED':
    case 'RESTRICTED':
      return 'warning';
    case 'PENDING_VERIFICATION':
      return 'info';
    case 'NOT_STARTED':
    default:
      return 'neutral';
  }
}

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
  const [filterType, setFilterType] = useState<'ALL' | 'PAYMENTS' | 'REFUNDS'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [showBankSettings, setShowBankSettings] = useState(!status.isReady);

  // State pour l'onboarding Connect Embedded
  const [country, setCountry] = useState<string>(DEFAULT_STRIPE_COUNTRY);
  const [isEmbeddedActive, setIsEmbeddedActive] = useState(false);
  const [stripeConnectInstance, setStripeConnectInstance] = useState<StripeConnectInstance | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Helper de formatage de devise
  function formatMoney(minor: number, currency: string = overview.currency): string {
    const amount = minor / 100;
    try {
      return new Intl.NumberFormat('fr-FR', {
        style: 'currency',
        currency: currency.toUpperCase(),
      }).format(amount);
    } catch {
      return `${amount.toFixed(2)} ${currency}`;
    }
  }

  // Initialisation de Stripe Connect Embedded instance
  const handleStartEmbeddedSession = useCallback(async (): Promise<void> => {
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

      const instance = loadConnectAndInitialize({
        publishableKey: session.publishableKey,
        fetchClientSecret: async () => {
          const freshSession = await createAccountSessionAction(organizationId);
          if (!freshSession.clientSecret) {
            throw new Error('Impossible de générer la session.');
          }
          return freshSession.clientSecret;
        },
        appearance: {
          overlays: 'dialog',
          variables: {
            ...getEmbeddedColors(),
            fontFamily: UTTILY_FONT_FAMILY,
          },
        },
        fonts: getEmbeddedFonts(),
      });

      setStripeConnectInstance(instance);
      setIsEmbeddedActive(true);
    } catch {
      setError('Impossible d’ouvrir l’espace de versement pour le moment. Veuillez réessayer.');
    } finally {
      setIsLoading(false);
    }
  }, [organizationId, status.readiness, country]);

  // Fallback portail hébergé
  async function handleHostedFallback(): Promise<void> {
    setError(null);
    setIsLoading(true);
    try {
      const result = await createOnboardingLinkAction(organizationId, {
        idempotencyKey: crypto.randomUUID(),
        origin: window.location.origin,
      });
      window.location.href = result.url;
    } catch {
      setError('Impossible de charger le portail de versement externe. Veuillez réessayer.');
      setIsLoading(false);
    }
  }

  function handleConnectExit(): void {
    window.location.reload();
  }

  // Filtrage local interactif
  const filteredActivity = overview.activity.filter((item) => {
    if (filterType === 'PAYMENTS' && item.type !== 'PAYMENT') return false;
    if (filterType === 'REFUNDS' && item.type !== 'REFUND') return false;

    if (searchQuery.trim().length > 0) {
      const q = searchQuery.toLowerCase().trim();
      const matchRef = item.bookingReference.toLowerCase().includes(q);
      const matchProd = item.productName?.toLowerCase().includes(q) ?? false;
      const matchClient = item.customerEmail?.toLowerCase().includes(q) ?? false;
      if (!matchRef && !matchProd && !matchClient) return false;
    }

    return true;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <PageHeader
        eyebrow="Finances"
        title="Revenus & Versements"
        description={`Période : ${overview.period.label} · Suivi de vos encaissements, commissions et versements.`}
        actions={
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            <LinkButton
              href={`/api/dashboard/${organizationId}/finances/export-csv`}
              variant="secondary"
            >
              📥 Exporter CSV
            </LinkButton>
            <Button
              type="button"
              variant={showBankSettings ? 'secondary' : 'primary'}
              onClick={() => setShowBankSettings(!showBankSettings)}
            >
              {showBankSettings ? 'Masquer config bancaire' : '⚙️ Espace bancaire'}
            </Button>
          </div>
        }
      />

      {/* Bloc Statut Compte Bancaire / Onboarding */}
      {showBankSettings && (
        <Card
          style={{
            padding: '1.5rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1.25rem',
            border: '2px solid var(--ut-color-primary)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: '1rem',
              flexWrap: 'wrap',
            }}
          >
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  marginBottom: '0.25rem',
                }}
              >
                <h2
                  style={{
                    fontSize: '1.15rem',
                    fontWeight: 'var(--ut-weight-bold)',
                    margin: 0,
                    color: 'var(--ut-color-ink-strong)',
                  }}
                >
                  Compte de versement bancaire
                </h2>
                <Badge tone={getAccountBadgeTone(status.readiness)}>{status.label}</Badge>
              </div>
              <p style={{ color: 'var(--ut-color-ink-muted)', margin: 0, fontSize: '0.9rem' }}>
                {status.description}
              </p>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {status.readiness === 'NOT_STARTED' && (
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <select
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    disabled={isLoading}
                    style={{
                      padding: '0.45rem 0.6rem',
                      borderRadius: 'var(--ut-radius-md)',
                      border: 'var(--ut-border-thin)',
                      fontSize: '0.85rem',
                      background: 'var(--ut-color-surface)',
                    }}
                  >
                    {STRIPE_SUPPORTED_COUNTRIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    onClick={handleStartEmbeddedSession}
                    disabled={isLoading}
                    variant="primary"
                  >
                    {isLoading ? 'Initialisation…' : 'Activer les versements'}
                  </Button>
                </div>
              )}

              {status.readiness !== 'NOT_STARTED' && (
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <Button
                    type="button"
                    onClick={handleStartEmbeddedSession}
                    disabled={isLoading}
                    variant="primary"
                  >
                    {isLoading ? 'Chargement…' : 'Ouvrir mon espace bancaire'}
                  </Button>
                  <Button
                    type="button"
                    onClick={handleHostedFallback}
                    disabled={isLoading}
                    variant="secondary"
                  >
                    Portail externe ↗
                  </Button>
                </div>
              )}
            </div>
          </div>

          {error && (
            <div
              style={{
                background: 'var(--ut-color-danger-soft)',
                color: 'var(--ut-color-danger)',
                padding: '0.75rem',
                borderRadius: 'var(--ut-radius-md)',
                fontSize: '0.875rem',
              }}
            >
              {error}
            </div>
          )}

          {/* Interface Stripe Connect Embedded */}
          {isEmbeddedActive && stripeConnectInstance && (
            <div
              style={{
                borderTop: 'var(--ut-border-thin)',
                paddingTop: '1.25rem',
                marginTop: '0.5rem',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '1rem',
                }}
              >
                <span style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}>
                  Espace bancaire sécurisé par notre partenaire de paiement
                </span>
                <Button
                  type="button"
                  variant="quiet"
                  size="sm"
                  aria-label="Fermer l’espace de versement"
                  onClick={handleConnectExit}
                >
                  ✕ Fermer l’espace
                </Button>
              </div>

              <ConnectComponentsProvider connectInstance={stripeConnectInstance}>
                {status.readiness === 'NOT_STARTED' ||
                status.readiness === 'PENDING_VERIFICATION' ? (
                  <ConnectAccountOnboarding onExit={handleConnectExit} />
                ) : (
                  <ConnectAccountManagement />
                )}
              </ConnectComponentsProvider>
            </div>
          )}
        </Card>
      )}

      {/* Cartes KPI Financiers */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '1rem',
        }}
      >
        <Card
          style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}
        >
          <span
            style={{
              fontSize: '1.75rem',
              fontWeight: 'var(--ut-weight-bold)',
              color: 'var(--ut-color-ink-strong)',
            }}
          >
            {formatMoney(overview.sales.grossAmountMinor)}
          </span>
          <span style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}>
            Prix location
          </span>
        </Card>

        <Card
          style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}
        >
          <span
            style={{
              fontSize: '1.75rem',
              fontWeight: 'var(--ut-weight-bold)',
              color: 'var(--ut-color-success)',
            }}
          >
            {formatMoney(overview.merchant.netAfterCommissionMinor)}
          </span>
          <span style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}>
            Net location (avant versement bancaire)
          </span>
        </Card>

        <Card
          style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}
        >
          <span
            style={{
              fontSize: '1.75rem',
              fontWeight: 'var(--ut-weight-bold)',
              color: 'var(--ut-color-ink-muted)',
            }}
          >
            {formatMoney(overview.commissions.platformAmountMinor)}
          </span>
          <span style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}>
            Frais plateforme loueur
          </span>
        </Card>

        <Card
          style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}
        >
          <span
            style={{
              fontSize: '1.75rem',
              fontWeight: 'var(--ut-weight-bold)',
              color:
                overview.payments.refundedAmountMinor > 0
                  ? 'var(--ut-color-danger)'
                  : 'var(--ut-color-ink-muted)',
            }}
          >
            {formatMoney(overview.payments.refundedAmountMinor)}
          </span>
          <span style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}>
            Remboursements
          </span>
        </Card>
      </div>

      {/* Tableau d'activité financière */}
      <Card style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '1rem',
            flexWrap: 'wrap',
          }}
        >
          <h2
            style={{
              fontSize: '1.15rem',
              fontWeight: 'var(--ut-weight-bold)',
              margin: 0,
              color: 'var(--ut-color-ink-strong)',
            }}
          >
            Historique des opérations ({filteredActivity.length})
          </h2>

          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="text"
              aria-label="Rechercher par référence, équipement, client"
              placeholder="Rechercher par référence, équipement, client..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                padding: '0.4rem 0.65rem',
                borderRadius: 'var(--ut-radius-md)',
                border: 'var(--ut-border-thin)',
                fontSize: '0.85rem',
                width: '240px',
              }}
            />
            <div style={{ display: 'flex', gap: '0.25rem' }}>
              <button
                type="button"
                aria-pressed={filterType === 'ALL'}
                onClick={() => setFilterType('ALL')}
                style={{
                  padding: '0.4rem 0.65rem',
                  borderRadius: 'var(--ut-radius-md)',
                  fontSize: '0.8rem',
                  fontWeight: 'var(--ut-weight-semibold)',
                  border: 'var(--ut-border-thin)',
                  background:
                    filterType === 'ALL' ? 'var(--ut-color-ink-strong)' : 'var(--ut-color-surface)',
                  color: filterType === 'ALL' ? 'var(--ut-color-surface)' : 'var(--ut-color-ink)',
                  cursor: 'pointer',
                }}
              >
                Toutes
              </button>
              <button
                type="button"
                aria-pressed={filterType === 'PAYMENTS'}
                onClick={() => setFilterType('PAYMENTS')}
                style={{
                  padding: '0.4rem 0.65rem',
                  borderRadius: 'var(--ut-radius-md)',
                  fontSize: '0.8rem',
                  fontWeight: 'var(--ut-weight-semibold)',
                  border: 'var(--ut-border-thin)',
                  background:
                    filterType === 'PAYMENTS'
                      ? 'var(--ut-color-ink-strong)'
                      : 'var(--ut-color-surface)',
                  color:
                    filterType === 'PAYMENTS' ? 'var(--ut-color-surface)' : 'var(--ut-color-ink)',
                  cursor: 'pointer',
                }}
              >
                Encaissements
              </button>
              <button
                type="button"
                aria-pressed={filterType === 'REFUNDS'}
                onClick={() => setFilterType('REFUNDS')}
                style={{
                  padding: '0.4rem 0.65rem',
                  borderRadius: 'var(--ut-radius-md)',
                  fontSize: '0.8rem',
                  fontWeight: 'var(--ut-weight-semibold)',
                  border: 'var(--ut-border-thin)',
                  background:
                    filterType === 'REFUNDS'
                      ? 'var(--ut-color-ink-strong)'
                      : 'var(--ut-color-surface)',
                  color:
                    filterType === 'REFUNDS' ? 'var(--ut-color-surface)' : 'var(--ut-color-ink)',
                  cursor: 'pointer',
                }}
              >
                Remboursements
              </button>
            </div>
          </div>
        </div>

        {filteredActivity.length === 0 ? (
          <p
            style={{
              color: 'var(--ut-color-ink-muted)',
              margin: '1rem 0',
              fontSize: '0.9rem',
              textAlign: 'center',
            }}
          >
            Aucune opération financière ne correspond à vos filtres.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
              <thead>
                <tr
                  style={{
                    background: 'var(--ut-color-surface-soft)',
                    borderBottom: 'var(--ut-border-thin)',
                  }}
                >
                  <th
                    style={{
                      padding: '0.75rem',
                      textAlign: 'left',
                      color: 'var(--ut-color-ink-muted)',
                    }}
                  >
                    Date
                  </th>
                  <th
                    style={{
                      padding: '0.75rem',
                      textAlign: 'left',
                      color: 'var(--ut-color-ink-muted)',
                    }}
                  >
                    Opération
                  </th>
                  <th
                    style={{
                      padding: '0.75rem',
                      textAlign: 'left',
                      color: 'var(--ut-color-ink-muted)',
                    }}
                  >
                    Réservation
                  </th>
                  <th
                    style={{
                      padding: '0.75rem',
                      textAlign: 'right',
                      color: 'var(--ut-color-ink-muted)',
                    }}
                  >
                    Prix location
                  </th>
                  <th
                    style={{
                      padding: '0.75rem',
                      textAlign: 'right',
                      color: 'var(--ut-color-ink-muted)',
                    }}
                  >
                    Frais plateforme loueur
                  </th>
                  <th
                    style={{
                      padding: '0.75rem',
                      textAlign: 'right',
                      color: 'var(--ut-color-ink-muted)',
                    }}
                  >
                    Net
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredActivity.map((item) => (
                  <tr key={item.id} style={{ borderBottom: 'var(--ut-border-thin)' }}>
                    <td style={{ padding: '0.75rem', color: 'var(--ut-color-ink-muted)' }}>
                      {new Intl.DateTimeFormat('fr-FR', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      }).format(new Date(item.date))}
                    </td>
                    <td style={{ padding: '0.75rem' }}>
                      <Badge tone={item.type === 'PAYMENT' ? 'success' : 'danger'}>
                        {item.type === 'PAYMENT' ? 'Encaissement' : 'Remboursement'}
                      </Badge>
                    </td>
                    <td style={{ padding: '0.75rem' }}>
                      {item.bookingId ? (
                        <Link
                          href={`/dashboard/${organizationId}/bookings/${item.bookingId}`}
                          style={{
                            color: 'var(--ut-color-primary)',
                            fontWeight: 'var(--ut-weight-semibold)',
                            textDecoration: 'none',
                          }}
                        >
                          {item.bookingReference}
                        </Link>
                      ) : (
                        <span style={{ fontWeight: 'var(--ut-weight-semibold)' }}>
                          {item.bookingReference}
                        </span>
                      )}
                      {item.productName && (
                        <div style={{ fontSize: '0.8rem', color: 'var(--ut-color-ink-muted)' }}>
                          {item.productName}
                        </div>
                      )}
                    </td>
                    <td
                      style={{
                        padding: '0.75rem',
                        textAlign: 'right',
                        fontWeight: 'var(--ut-weight-semibold)',
                      }}
                    >
                      {formatMoney(item.grossAmountMinor, item.currency)}
                    </td>
                    <td
                      style={{
                        padding: '0.75rem',
                        textAlign: 'right',
                        color: 'var(--ut-color-ink-muted)',
                      }}
                    >
                      {formatMoney(item.commissionAmountMinor, item.currency)}
                    </td>
                    <td
                      style={{
                        padding: '0.75rem',
                        textAlign: 'right',
                        fontWeight: 'var(--ut-weight-bold)',
                        color:
                          item.netAmountMinor >= 0
                            ? 'var(--ut-color-success)'
                            : 'var(--ut-color-danger)',
                      }}
                    >
                      {formatMoney(item.netAmountMinor, item.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
