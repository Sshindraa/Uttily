import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMaintenanceCaseDetails } from '@uttily/core';
import { requireCatalogViewerOf } from '@/lib/catalog-auth';
import { formatDateTimeInTimeZone, isValidUuid } from '@/lib/operations-helpers';
import { ResolveMaintenanceModal } from './resolve-maintenance-modal';
import styles from './case-detail.module.css';

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
    <div className={styles.container}>
      {/* Retour Atelier */}
      <div className={styles.backRow}>
        <Link href={`/dashboard/${organizationId}/fleet/maintenance`} className={styles.backLink}>
          ← Retour aux dossiers de maintenance
        </Link>
      </div>

      {/* Hero Header */}
      <div className={styles.headerCard}>
        <div className={styles.headerMain}>
          <div>
            <div className={styles.skuRow}>
              <span className={styles.skuBadge}>{caseDetails.internalSku}</span>
              <span className={styles.serialBadge}>
                {caseDetails.serialNumber
                  ? `N° ${caseDetails.serialNumber}`
                  : 'Sans numéro de série'}
              </span>
            </div>
            <h1 className={styles.pageTitle}>
              {caseDetails.productName} ({caseDetails.variantName})
            </h1>
          </div>

          <span
            className={`${styles.statusBadge} ${
              isResolved ? styles.statusResolved : styles.statusOpen
            }`}
          >
            {isResolved ? '✓ Réparation terminée' : '⚠️ En maintenance'}
          </span>
        </div>

        {/* CTA Remise en service */}
        {!isResolved && (
          <div className={styles.actionHero}>
            <ResolveMaintenanceModal
              orgId={organizationId}
              maintenanceBlockId={caseDetails.id}
              internalSku={caseDetails.internalSku}
            />
          </div>
        )}
      </div>

      {/* Détails du dossier */}
      <div className={styles.grid}>
        {/* Pilier 1 : Problème & Origine */}
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>
            <span>🔍</span> Diagnostic &amp; Problème constaté
          </h2>

          <div className={styles.issueBox}>
            <span className={styles.issueLabel}>Description du problème :</span>
            <strong className={styles.issueText}>« {caseDetails.reason} »</strong>
          </div>

          <div className={styles.detailsList}>
            <div className={styles.detailRow}>
              <span>Point d'attache :</span>
              <strong>📍 {caseDetails.locationName}</strong>
            </div>
            <div className={styles.detailRow}>
              <span>Signalé le :</span>
              <strong>
                {formatDateTimeInTimeZone(caseDetails.openedAt, caseDetails.locationTimeZone)}
              </strong>
            </div>
            <div className={styles.detailRow}>
              <span>Origine :</span>
              <strong>
                {caseDetails.sourceDamageReportId
                  ? 'Constaté lors du retour locataire'
                  : "Ouvert manuellement par l'équipe atelier"}
              </strong>
            </div>
          </div>
        </section>

        {/* Pilier 2 : Exemplaire Physique */}
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>
            <span>🚲</span> Exemplaire physique
          </h2>

          <div className={styles.itemInfo}>
            <div className={styles.detailRow}>
              <span>Code / SKU :</span>
              <Link
                href={`/dashboard/${organizationId}/inventory/${caseDetails.inventoryItemId}`}
                className={styles.itemSkuLink}
              >
                {caseDetails.internalSku} →
              </Link>
            </div>
            <div className={styles.detailRow}>
              <span>État physique :</span>
              <strong>{caseDetails.condition}</strong>
            </div>
            <div className={styles.detailRow}>
              <span>Disponibilité réservation :</span>
              <span className={isResolved ? styles.tagAvailable : styles.tagBlocked}>
                {isResolved ? '🟢 Disponible à la réservation' : '🔴 Bloqué (Non réservable)'}
              </span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
