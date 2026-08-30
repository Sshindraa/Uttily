import Link from 'next/link';
import {
  listUnifiedBikes,
  getMembership,
  CATALOG_MANAGERS,
  type UnifiedBikeStatusSummary,
} from '@uttily/core';
import { requireCatalogViewerOf } from '@/lib/catalog-auth';
import {
  formatMoneyAmount,
  getPricingPlanTypeLabel,
  getPricingPlanUnitLabel,
} from '@/lib/status-presentation';
import { PageHeader, Card, Badge, LinkButton, Icon } from '@uttily/ui';
import type { BadgeTone } from '@uttily/ui';

function getStatusBadgeProps(status: UnifiedBikeStatusSummary): { tone: BadgeTone; label: string } {
  switch (status) {
    case 'ONLINE_AVAILABLE':
      return { tone: 'success', label: 'En ligne · Disponible' };
    case 'ONLINE_UNAVAILABLE':
      return { tone: 'warning', label: 'En ligne · Indisponible' };
    case 'READY_TO_PUBLISH':
      return { tone: 'info', label: 'Prêt à publier' };
    case 'INCOMPLETE':
      return { tone: 'neutral', label: 'Configuration incomplète' };
    case 'ARCHIVED':
      return { tone: 'neutral', label: 'Archivé' };
  }
}

export default async function BikesListPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const { db, organizationId, user } = await requireCatalogViewerOf(orgId);

  const bikes = await listUnifiedBikes(db, organizationId);
  const membership = await getMembership(db, organizationId, user.id);
  const canManage = membership !== null && CATALOG_MANAGERS.includes(membership.role);

  const totalActiveFleet = bikes.reduce((acc, b) => acc + b.activeInventoryCount, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <PageHeader
        eyebrow="Flotte & Références"
        title="Mes équipements"
        description={`${bikes.length} référence(s) · ${totalActiveFleet} exemplaire(s) en service`}
        actions={
          canManage ? (
            <LinkButton href={`/dashboard/${organizationId}/bikes/new`} variant="primary">
              Ajouter un équipement
            </LinkButton>
          ) : undefined
        }
      />

      {bikes.length === 0 ? (
        <Card
          style={{
            textAlign: 'center',
            padding: '3.5rem 1.5rem',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '1rem',
          }}
        >
          <div style={{ fontSize: '3rem' }}>🚲</div>
          <h2
            style={{
              fontSize: '1.25rem',
              fontWeight: 700,
              margin: 0,
              color: 'var(--ut-color-ink-strong)',
            }}
          >
            Aucun équipement pour le moment
          </h2>
          <p style={{ color: 'var(--ut-color-ink-muted)', margin: 0, maxWidth: '28rem' }}>
            Ajoutez votre premier équipement pour définir ses photos, son tarif journalier et vos
            exemplaires disponibles.
          </p>
          {canManage && (
            <LinkButton href={`/dashboard/${organizationId}/bikes/new`} variant="primary">
              Ajouter mon premier équipement →
            </LinkButton>
          )}
        </Card>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
            gap: '1.5rem',
          }}
        >
          {bikes.map((bike) => {
            const isReadyOrOnline =
              bike.statusSummary === 'ONLINE_AVAILABLE' ||
              bike.statusSummary === 'ONLINE_UNAVAILABLE' ||
              bike.statusSummary === 'READY_TO_PUBLISH';

            const targetHref = isReadyOrOnline
              ? `/dashboard/${organizationId}/bikes/${bike.id}`
              : `/dashboard/${organizationId}/bikes/${bike.id}/setup`;

            const badgeProps = getStatusBadgeProps(bike.statusSummary);

            return (
              <Card
                key={bike.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: '1.25rem',
                  padding: '1.5rem',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      gap: '0.5rem',
                    }}
                  >
                    <div>
                      <h2
                        style={{
                          fontSize: '1.2rem',
                          fontWeight: 700,
                          margin: '0 0 0.25rem 0',
                          color: 'var(--ut-color-ink-strong)',
                        }}
                      >
                        {bike.name}
                      </h2>
                      <span style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}>
                        {bike.categoryName} · Version : <strong>{bike.variantName}</strong>
                      </span>
                    </div>
                    <Badge tone={badgeProps.tone}>{badgeProps.label}</Badge>
                  </div>

                  <div
                    style={{
                      background: 'var(--ut-color-surface-soft)',
                      padding: '0.85rem',
                      borderRadius: 'var(--ut-radius-md)',
                      fontSize: '0.85rem',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.4rem',
                      border: 'var(--ut-border-thin)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span style={{ color: 'var(--ut-color-ink-muted)' }}>Photos (3 vues) :</span>
                      <strong
                        style={{
                          color: bike.hasRequiredPhotos
                            ? 'var(--ut-color-success)'
                            : 'var(--ut-color-warning)',
                        }}
                      >
                        {bike.hasRequiredPhotos ? '✓' : '○'} {bike.photoCount}/3 vues requises
                      </strong>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span style={{ color: 'var(--ut-color-ink-muted)' }}>
                        {bike.pricingPlanType
                          ? `${getPricingPlanTypeLabel(bike.pricingPlanType)} :`
                          : 'Tarif :'}
                      </span>
                      <strong style={{ color: 'var(--ut-color-ink-strong)' }}>
                        {bike.priceAmountMinor !== null
                          ? `${formatMoneyAmount(bike.priceAmountMinor, bike.pricingCurrency ?? 'EUR')}${
                              bike.pricingPlanType
                                ? ` ${getPricingPlanUnitLabel(bike.pricingPlanType)}`
                                : ''
                            }`
                          : '○ Non configuré'}
                      </strong>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span style={{ color: 'var(--ut-color-ink-muted)' }}>
                        Exemplaires en flotte :
                      </span>
                      <strong
                        style={{
                          color:
                            bike.activeInventoryCount >= 1
                              ? 'var(--ut-color-success)'
                              : 'var(--ut-color-ink-muted)',
                        }}
                      >
                        {bike.activeInventoryCount >= 1 ? '✓' : '○'} {bike.activeInventoryCount}{' '}
                        exemplaire(s)
                      </strong>
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    paddingTop: '0.75rem',
                    borderTop: 'var(--ut-border-thin)',
                    display: 'flex',
                    justifyContent: 'flex-end',
                  }}
                >
                  <Link
                    href={targetHref}
                    style={{
                      fontSize: '0.9rem',
                      fontWeight: 600,
                      color: 'var(--ut-color-primary)',
                      textDecoration: 'none',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                    }}
                  >
                    {isReadyOrOnline ? 'Gérer l’équipement' : 'Continuer la configuration'}{' '}
                    <Icon name="arrow-right" size={16} />
                  </Link>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
