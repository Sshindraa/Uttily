import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMaintenanceCaseDetails } from '@uttily/core';
import { requireCatalogViewerOf } from '@/lib/catalog-auth';
import { formatDateTimeInTimeZone, isValidUuid } from '@/lib/operations-helpers';
import { getInventoryConditionPresentation } from '@/lib/status-presentation';
import type { InventoryCondition } from '@uttily/contracts';
import { PageHeader, Card, Badge } from '@uttily/ui';
import { ResolveMaintenanceModal } from './resolve-maintenance-modal';

export default async function MaintenanceCaseDetailPage({
  params,
}: {
  params: Promise<{ orgId: string; blockId: string }>;
}): Promise<React.ReactElement> {
  const { orgId, blockId } = await params;

  if (!isValidUuid(blockId)) notFound();

  const { db, organizationId } = await requireCatalogViewerOf(orgId);
  const caseDetails = await getMaintenanceCaseDetails(db, organizationId, blockId);
  if (caseDetails === null) notFound();

  const isResolved = caseDetails.status === 'RESOLVED';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <Link
        href={`/dashboard/${organizationId}/fleet/maintenance`}
        style={{
          color: 'var(--ut-color-primary)',
          fontWeight: 600,
          textDecoration: 'none',
          fontSize: '0.95rem',
        }}
      >
        ← Retour aux dossiers de maintenance
      </Link>

      <PageHeader
        eyebrow={`Référence : ${caseDetails.internalSku}`}
        title={`${caseDetails.productName} (${caseDetails.variantName})`}
        description={`Établissement : ${caseDetails.locationName} · N° de série : ${caseDetails.serialNumber ?? 'Sans numéro'}`}
        actions={
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <Badge tone={isResolved ? 'success' : 'warning'}>
              {isResolved
                ? '✓ Réparation terminée'
                : caseDetails.status === 'IN_PROGRESS'
                  ? '🔧 Intervention en cours'
                  : '⚠️ À traiter'}
            </Badge>

            {!isResolved && (
              <ResolveMaintenanceModal
                orgId={organizationId}
                maintenanceCaseId={caseDetails.id}
                internalSku={caseDetails.internalSku}
                currentStatus={caseDetails.status}
              />
            )}
          </div>
        }
      />

      {/* Grille des Détails du dossier */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: '1.5rem',
        }}
      >
        {/* Pilier 1 : Diagnostic & Problème constaté */}
        <Card style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h2
            style={{
              fontSize: '1.1rem',
              fontWeight: 700,
              margin: 0,
              color: 'var(--ut-color-ink-strong)',
            }}
          >
            🔍 Diagnostic &amp; Problème constaté
          </h2>

          <div
            style={{
              background: 'var(--ut-color-surface-soft)',
              padding: '1rem',
              borderRadius: 'var(--ut-radius-md)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem',
              border: 'var(--ut-border-thin)',
            }}
          >
            <div>
              <span style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.85rem' }}>
                Description du problème :
              </span>
              <strong
                style={{
                  display: 'block',
                  fontSize: '0.95rem',
                  color: 'var(--ut-color-ink-strong)',
                  marginTop: '0.2rem',
                }}
              >
                « {caseDetails.reason} »
              </strong>
            </div>

            {caseDetails.openedNotes && (
              <p
                style={{
                  margin: '0.25rem 0 0 0',
                  fontSize: '0.85rem',
                  color: 'var(--ut-color-warning)',
                }}
              >
                Note : {caseDetails.openedNotes}
              </p>
            )}

            {caseDetails.resolutionNotes && (
              <p
                style={{
                  margin: '0.25rem 0 0 0',
                  fontSize: '0.85rem',
                  color: 'var(--ut-color-success)',
                }}
              >
                Travaux réalisés : {caseDetails.resolutionNotes}
              </p>
            )}
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '0.4rem',
              fontSize: '0.875rem',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--ut-color-ink-muted)' }}>Établissement :</span>
              <strong>📍 {caseDetails.locationName}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--ut-color-ink-muted)' }}>Signalé le :</span>
              <strong>
                {formatDateTimeInTimeZone(caseDetails.openedAt, caseDetails.locationTimeZone)}
              </strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--ut-color-ink-muted)' }}>Origine :</span>
              <strong>
                {caseDetails.sourceDamageReportId
                  ? 'Constaté lors du retour locataire'
                  : 'Ouvert manuellement par l’équipe atelier'}
              </strong>
            </div>
          </div>
        </Card>

        {/* Pilier 2 : Vélo concerné */}
        <Card style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h2
            style={{
              fontSize: '1.1rem',
              fontWeight: 700,
              margin: 0,
              color: 'var(--ut-color-ink-strong)',
            }}
          >
            🚲 Vélo concerné
          </h2>

          <div
            style={{
              background: 'var(--ut-color-surface-soft)',
              padding: '1rem',
              borderRadius: 'var(--ut-radius-md)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.5rem',
              border: 'var(--ut-border-thin)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.85rem' }}>
                Référence vélo :
              </span>
              <Link
                href={`/dashboard/${organizationId}/fleet`}
                style={{
                  color: 'var(--ut-color-primary)',
                  fontWeight: 700,
                  textDecoration: 'none',
                }}
              >
                {caseDetails.internalSku} →
              </Link>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.85rem' }}>
                État physique :
              </span>
              <Badge tone={caseDetails.condition === 'BROKEN' ? 'danger' : 'warning'}>
                {
                  getInventoryConditionPresentation(caseDetails.condition as InventoryCondition)
                    .label
                }
              </Badge>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: 'var(--ut-color-ink-muted)', fontSize: '0.85rem' }}>
                Disponibilité réservation :
              </span>
              <Badge tone={isResolved ? 'success' : 'danger'}>
                {isResolved ? 'Disponible à la location' : 'Bloqué / Indisponible'}
              </Badge>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
