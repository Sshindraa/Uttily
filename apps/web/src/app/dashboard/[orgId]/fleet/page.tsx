import Link from 'next/link';
import { listInventorySummaries, getMembership, CATALOG_MANAGERS } from '@uttily/core';
import { requireCatalogViewerOf } from '@/lib/catalog-auth';
import {
  getInventoryConditionPresentation,
  getInventoryStatusPresentation,
} from '@/lib/status-presentation';
import { PageHeader, Card, Badge, LinkButton } from '@uttily/ui';
import { OpenMaintenanceModal } from './open-maintenance-modal';
import styles from './fleet.module.css';

export default async function FleetListPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { db, organizationId, user } = await requireCatalogViewerOf((await params).orgId);
  const items = await listInventorySummaries(db, organizationId);
  const membership = await getMembership(db, organizationId, user.id);
  const canManage = membership !== null && CATALOG_MANAGERS.includes(membership.role);

  const availableCount = items.filter(
    (i) => i.status === 'ACTIVE' && i.condition !== 'BROKEN',
  ).length;
  const maintenanceCount = items.filter((i) => i.condition === 'BROKEN').length;

  const selectableItems = items.map((i) => ({
    id: i.id,
    internalSku: i.internalSku,
    productName: `${i.productName} (${i.variantName})`,
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <PageHeader
        eyebrow="Inventaire physique"
        title="Flotte"
        description="Suivi unitaire de vos équipements en service, états et maintenance."
        actions={
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <LinkButton href={`/dashboard/${organizationId}/fleet/maintenance`} variant="secondary">
              Atelier ({maintenanceCount})
            </LinkButton>
            {canManage && items.length > 0 && (
              <OpenMaintenanceModal orgId={organizationId} items={selectableItems} />
            )}
            {canManage && (
              <LinkButton href={`/dashboard/${organizationId}/bikes`} variant="primary">
                Gérer mes équipements
              </LinkButton>
            )}
          </div>
        }
      />

      {/* Cartes de synthèse */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '1rem',
        }}
      >
        <Card
          style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}
        >
          <span
            style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--ut-color-ink-strong)' }}
          >
            {items.length}
          </span>
          <span style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}>
            Équipements au total
          </span>
        </Card>
        <Card
          style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}
        >
          <span style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--ut-color-success)' }}>
            {availableCount}
          </span>
          <span style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}>
            Disponibles
          </span>
        </Card>
        <Card
          style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}
        >
          <span style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--ut-color-warning)' }}>
            {maintenanceCount}
          </span>
          <span style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}>
            En maintenance
          </span>
        </Card>
      </div>

      {items.length === 0 ? (
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
            Aucun équipement dans votre flotte
          </h2>
          <p style={{ color: 'var(--ut-color-ink-muted)', margin: 0, maxWidth: '28rem' }}>
            Ajoutez vos équipements depuis la rubrique Mes équipements pour les rendre disponibles à
            la location.
          </p>
          {canManage && (
            <LinkButton href={`/dashboard/${organizationId}/bikes/new`} variant="primary">
              Ajouter mon premier équipement
            </LinkButton>
          )}
        </Card>
      ) : (
        <Card style={{ overflowX: 'auto', padding: 0 }}>
          <table className={styles.table} style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr
                style={{
                  background: 'var(--ut-color-surface-soft)',
                  borderBottom: 'var(--ut-border-thin)',
                }}
              >
                <th
                  style={{
                    padding: '0.85rem 1rem',
                    textAlign: 'left',
                    fontSize: '0.85rem',
                    color: 'var(--ut-color-ink-muted)',
                  }}
                >
                  Référence exemplaire
                </th>
                <th
                  style={{
                    padding: '0.85rem 1rem',
                    textAlign: 'left',
                    fontSize: '0.85rem',
                    color: 'var(--ut-color-ink-muted)',
                  }}
                >
                  Équipement / Version
                </th>
                <th
                  style={{
                    padding: '0.85rem 1rem',
                    textAlign: 'left',
                    fontSize: '0.85rem',
                    color: 'var(--ut-color-ink-muted)',
                  }}
                >
                  N° de série
                </th>
                <th
                  style={{
                    padding: '0.85rem 1rem',
                    textAlign: 'left',
                    fontSize: '0.85rem',
                    color: 'var(--ut-color-ink-muted)',
                  }}
                >
                  État
                </th>
                <th
                  style={{
                    padding: '0.85rem 1rem',
                    textAlign: 'left',
                    fontSize: '0.85rem',
                    color: 'var(--ut-color-ink-muted)',
                  }}
                >
                  Statut
                </th>
                <th
                  style={{
                    padding: '0.85rem 1rem',
                    textAlign: 'left',
                    fontSize: '0.85rem',
                    color: 'var(--ut-color-ink-muted)',
                  }}
                >
                  Établissement
                </th>
                <th
                  style={{
                    padding: '0.85rem 1rem',
                    textAlign: 'right',
                    fontSize: '0.85rem',
                    color: 'var(--ut-color-ink-muted)',
                  }}
                ></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const isBroken = item.condition === 'BROKEN';
                const conditionPresentation = getInventoryConditionPresentation(item.condition);
                const statusPresentation = getInventoryStatusPresentation(item.status, isBroken);
                const bikeLink = `/dashboard/${organizationId}/bikes/${item.productId}`;

                return (
                  <tr key={item.id} style={{ borderBottom: 'var(--ut-border-thin)' }}>
                    <td style={{ padding: '1rem', fontWeight: 600 }}>
                      <Link
                        href={bikeLink}
                        style={{ color: 'var(--ut-color-primary)', textDecoration: 'none' }}
                      >
                        {item.internalSku}
                      </Link>
                    </td>
                    <td style={{ padding: '1rem' }}>
                      <strong style={{ color: 'var(--ut-color-ink-strong)' }}>
                        {item.productName}
                      </strong>
                      <span
                        style={{
                          marginLeft: '0.5rem',
                          fontSize: '0.8rem',
                          background: 'var(--ut-color-surface-soft)',
                          padding: '0.2rem 0.5rem',
                          borderRadius: 'var(--ut-radius-sm)',
                        }}
                      >
                        {item.variantName}
                      </span>
                    </td>
                    <td
                      style={{
                        padding: '1rem',
                        color: 'var(--ut-color-ink-muted)',
                        fontSize: '0.9rem',
                      }}
                    >
                      {item.serialNumber ?? '—'}
                    </td>
                    <td style={{ padding: '1rem' }}>
                      <Badge tone={isBroken ? 'danger' : 'success'}>
                        {conditionPresentation.label}
                      </Badge>
                    </td>
                    <td style={{ padding: '1rem' }}>
                      <Badge
                        tone={
                          isBroken ? 'warning' : item.status === 'ACTIVE' ? 'success' : 'neutral'
                        }
                      >
                        {statusPresentation.label}
                      </Badge>
                    </td>
                    <td
                      style={{
                        padding: '1rem',
                        color: 'var(--ut-color-ink-muted)',
                        fontSize: '0.9rem',
                      }}
                    >
                      📍 {item.locationName}
                    </td>
                    <td style={{ padding: '1rem', textAlign: 'right' }}>
                      <Link
                        href={bikeLink}
                        style={{
                          fontSize: '0.85rem',
                          color: 'var(--ut-color-primary)',
                          fontWeight: 600,
                          textDecoration: 'none',
                        }}
                      >
                        Fiche équipement →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
