import Link from 'next/link';
import type { LocationRecord } from '@uttily/core';
import { PageHeader, Card, Badge, LinkButton, Icon } from '@uttily/ui';

export interface LocationsListViewProps {
  organizationId: string;
  locations: LocationRecord[];
  canManage: boolean;
}

export function LocationsListView({
  organizationId,
  locations: locationsList,
  canManage,
}: LocationsListViewProps): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <PageHeader
        eyebrow="Points de vente & ateliers"
        title="Établissements"
        description="Gérez vos points de retrait, horaires d'ouverture, consignes de départ et zones de desserte."
        actions={
          canManage ? (
            <LinkButton href={`/dashboard/${organizationId}/locations/new`} variant="primary">
              Ajouter un établissement
            </LinkButton>
          ) : undefined
        }
      />

      {locationsList.length === 0 ? (
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
          <div style={{ fontSize: '3rem' }}>📍</div>
          <h2
            style={{
              fontSize: '1.25rem',
              fontWeight: 'var(--ut-weight-bold)',
              margin: 0,
              color: 'var(--ut-color-ink-strong)',
            }}
          >
            Aucun établissement enregistré
          </h2>
          <p style={{ color: 'var(--ut-color-ink-muted)', margin: 0, maxWidth: '28rem' }}>
            {canManage
              ? 'Créez votre premier point de retrait pour permettre aux clients de réserver vos équipements.'
              : 'Aucun point de retrait n’a encore été configuré pour cette organisation.'}
          </p>
          {canManage && (
            <LinkButton href={`/dashboard/${organizationId}/locations/new`} variant="primary">
              Créer mon premier établissement
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
          {locationsList.map((loc) => (
            <Card
              key={loc.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: '1.25rem',
                padding: '1.5rem',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: '0.5rem',
                  }}
                >
                  <div>
                    <h3
                      style={{
                        fontSize: '1.2rem',
                        fontWeight: 'var(--ut-weight-bold)',
                        margin: '0 0 0.25rem 0',
                        color: 'var(--ut-color-ink-strong)',
                      }}
                    >
                      {loc.name}
                    </h3>
                    <span
                      style={{
                        fontSize: '0.8rem',
                        color: 'var(--ut-color-ink-muted)',
                        fontFamily: 'var(--ut-font-sans)',
                        fontVariantNumeric: 'lining-nums tabular-nums',
                      }}
                    >
                      /{loc.slug}
                    </span>
                  </div>
                  <Badge tone={loc.isPubliclyListed ? 'success' : 'neutral'}>
                    {loc.isPubliclyListed ? 'En ligne' : 'Brouillon'}
                  </Badge>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                  <Badge tone={loc.pickupEnabled ? 'info' : 'warning'}>
                    {loc.pickupEnabled ? '✓ Retrait actif' : 'Retrait suspendu'}
                  </Badge>
                  <Badge tone="neutral">{loc.timeZone}</Badge>
                </div>

                <div
                  style={{
                    background: 'var(--ut-color-surface-soft)',
                    padding: '0.85rem',
                    borderRadius: 'var(--ut-radius-md)',
                    fontSize: '0.9rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.25rem',
                  }}
                >
                  <strong style={{ color: 'var(--ut-color-ink-strong)' }}>📍 Adresse :</strong>
                  <span style={{ color: 'var(--ut-color-ink)' }}>
                    {[loc.addressLine1, loc.addressLine2].filter(Boolean).join(', ') ||
                      'Non renseignée'}
                  </span>
                  <span style={{ color: 'var(--ut-color-ink-muted)' }}>
                    {[loc.postalCode, loc.city, loc.countryCode].filter(Boolean).join(' ') || ''}
                  </span>
                  {loc.publicPhone && (
                    <span style={{ color: 'var(--ut-color-ink-muted)', marginTop: '0.25rem' }}>
                      📞 {loc.publicPhone}
                    </span>
                  )}
                </div>
              </div>

              {canManage && (
                <div
                  style={{
                    paddingTop: '0.75rem',
                    borderTop: 'var(--ut-border-thin)',
                    display: 'flex',
                    justifyContent: 'flex-end',
                  }}
                >
                  <Link
                    href={`/dashboard/${organizationId}/locations/${loc.id}`}
                    style={{
                      fontSize: '0.9rem',
                      fontWeight: 'var(--ut-weight-semibold)',
                      color: 'var(--ut-color-primary)',
                      textDecoration: 'none',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                    }}
                  >
                    Gérer l’établissement <Icon name="arrow-right" size={16} />
                  </Link>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
