import Link from 'next/link';
import { listMaintenanceCases } from '@uttily/core';
import { requireCatalogViewerOf } from '@/lib/catalog-auth';
import { formatDateTimeInTimeZone } from '@/lib/operations-helpers';
import { PageHeader, Card, Badge, LinkButton } from '@uttily/ui';

export default async function MaintenanceListPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { db, organizationId } = await requireCatalogViewerOf((await params).orgId);
  const allCases = await listMaintenanceCases(db, organizationId);

  const activeCases = allCases.filter((c) => c.status !== 'RESOLVED');
  const resolvedCases = allCases.filter((c) => c.status === 'RESOLVED');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <Link
        href={`/dashboard/${organizationId}/fleet`}
        style={{
          color: 'var(--ut-color-primary)',
          fontWeight: 600,
          textDecoration: 'none',
          fontSize: '0.95rem',
        }}
      >
        ← Retour à la flotte
      </Link>

      <PageHeader
        eyebrow="Atelier & Flotte"
        title="Atelier & Maintenance"
        description="Suivi des anomalies, réparations d’atelier et remise en service de votre flotte."
      />

      {/* Badges de synthèse */}
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
          <span style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--ut-color-warning)' }}>
            {activeCases.length}
          </span>
          <span style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}>
            Équipements en cours d’intervention
          </span>
        </Card>
        <Card
          style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}
        >
          <span style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--ut-color-success)' }}>
            {resolvedCases.length}
          </span>
          <span style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}>
            Réparations terminées
          </span>
        </Card>
      </div>

      {/* Dossiers Actifs */}
      <Card style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <h2
          style={{
            fontSize: '1.15rem',
            fontWeight: 700,
            margin: 0,
            color: 'var(--ut-color-ink-strong)',
          }}
        >
          ⚠️ Interventions à traiter ({activeCases.length})
        </h2>

        {activeCases.length === 0 ? (
          <p style={{ color: 'var(--ut-color-ink-muted)', margin: 0, fontSize: '0.9rem' }}>
            Aucune intervention de maintenance en cours.
          </p>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
              gap: '1rem',
            }}
          >
            {activeCases.map((c) => (
              <Card
                key={c.id}
                style={{
                  padding: '1.25rem',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: '1rem',
                  background: 'var(--ut-color-surface-soft)',
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
                      <span
                        style={{
                          fontSize: '0.8rem',
                          fontWeight: 700,
                          color: 'var(--ut-color-primary)',
                        }}
                      >
                        {c.internalSku}
                      </span>
                      <h3
                        style={{
                          fontSize: '1.05rem',
                          fontWeight: 700,
                          margin: '0.2rem 0 0',
                          color: 'var(--ut-color-ink-strong)',
                        }}
                      >
                        {c.productName} ({c.variantName})
                      </h3>
                    </div>
                    <Badge tone="warning">{c.status === 'OPEN' ? 'À traiter' : 'En cours'}</Badge>
                  </div>

                  <div style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink)' }}>
                    <span style={{ color: 'var(--ut-color-ink-muted)' }}>Problème signalé : </span>
                    <strong>« {c.reason} »</strong>
                  </div>

                  <div
                    style={{
                      fontSize: '0.8rem',
                      color: 'var(--ut-color-ink-muted)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.2rem',
                    }}
                  >
                    <span>📍 {c.locationName}</span>
                    <span>
                      Signalé le {formatDateTimeInTimeZone(c.openedAt, c.locationTimeZone)}
                    </span>
                  </div>
                </div>

                <div
                  style={{
                    paddingTop: '0.5rem',
                    borderTop: 'var(--ut-border-thin)',
                    display: 'flex',
                    justifyContent: 'flex-end',
                  }}
                >
                  <LinkButton
                    href={`/dashboard/${organizationId}/fleet/maintenance/${c.id}`}
                    variant="secondary"
                    size="sm"
                  >
                    Ouvrir le dossier d’atelier →
                  </LinkButton>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Card>

      {/* Historique des Réparations */}
      {resolvedCases.length > 0 && (
        <Card style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h2
            style={{
              fontSize: '1.15rem',
              fontWeight: 700,
              margin: 0,
              color: 'var(--ut-color-ink-strong)',
            }}
          >
            📜 Historique des réparations résolues ({resolvedCases.length})
          </h2>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {resolvedCases.map((c) => (
              <div
                key={c.id}
                style={{
                  background: 'var(--ut-color-surface-soft)',
                  padding: '0.85rem',
                  borderRadius: 'var(--ut-radius-md)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '0.5rem',
                  flexWrap: 'wrap',
                  border: 'var(--ut-border-thin)',
                }}
              >
                <div>
                  <span
                    style={{
                      fontSize: '0.8rem',
                      fontWeight: 700,
                      color: 'var(--ut-color-primary)',
                    }}
                  >
                    {c.internalSku}
                  </span>
                  <div style={{ fontSize: '0.9rem', color: 'var(--ut-color-ink-strong)' }}>
                    <strong>{c.productName}</strong> · « {c.reason} »
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <Badge tone="success">✓ Remis en service</Badge>
                  <span style={{ fontSize: '0.8rem', color: 'var(--ut-color-ink-muted)' }}>
                    {c.resolvedAt
                      ? formatDateTimeInTimeZone(c.resolvedAt, c.locationTimeZone)
                      : 'Résolu'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
