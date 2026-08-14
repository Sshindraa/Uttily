import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, eq, inArray } from 'drizzle-orm';
import { bookingAmendments } from '@uttily/database';
import {
  getOperationalBookingDetails,
  getMembership,
  INVENTORY_CONDITIONS,
  type BookingStatus,
  type InventoryCondition,
} from '@uttily/core';
import { requireFulfillmentOperatorOf } from '@/lib/fulfillment-auth';
import { getAmendmentEntryState } from '@/lib/amendment-auth';
import {
  bookingStatusLabel,
  formatDateTimeInTimeZone,
  conditionLabel,
  phaseLabel,
  eventTypeLabel,
  getTransitionAction,
  canCreatePickupReport,
  canCreateReturnReport,
  canCreateDamageReport,
  isReadOnlyStatus,
  isValidUuid,
} from '@/lib/operations-helpers';
import { TransitionAction } from './transition-action';
import { ConditionReportForm } from './condition-report-form';
import { DamageReportForm } from './damage-report-form';

// Props sérialisables passées aux Client Components.
// Aucune donnée personnelle, financière ou historique non nécessaire.
interface ItemProps {
  bookingItemId: string;
  internalSku: string;
  serialNumber: string | null;
  currentCondition: InventoryCondition;
}

export default async function OperationsDetailPage({
  params,
}: {
  params: Promise<{ orgId: string; bookingId: string }>;
}): Promise<React.ReactElement> {
  const { orgId, bookingId } = await params;

  // Validation UUID du paramètre avant toute query.
  if (!isValidUuid(bookingId)) notFound();

  const { user, db, organizationId } = await requireFulfillmentOperatorOf(orgId);
  const details = await getOperationalBookingDetails(db, organizationId, bookingId);
  if (details === null) notFound();

  const status: BookingStatus = details.status;
  const transitionInfo = getTransitionAction(status);
  const showPickupForm = canCreatePickupReport(status);
  const showReturnForm = canCreateReturnReport(status);
  const showDamageForm = canCreateDamageReport(status);
  const readOnly = isReadOnlyStatus(status);

  // Vérification de l'éligibilité à la modification (G7M-C5-A)
  const membership = await getMembership(db, organizationId, user.id);
  let hasActiveAmendment = false;
  if (status === 'CONFIRMED') {
    const activeAmendmentRows = await db
      .select({ id: bookingAmendments.id })
      .from(bookingAmendments)
      .where(
        and(
          eq(bookingAmendments.bookingId, bookingId),
          eq(bookingAmendments.organizationId, organizationId),
          inArray(bookingAmendments.status, ['HOLD_PENDING', 'READY_TO_APPLY']),
        ),
      )
      .limit(1);
    hasActiveAmendment = activeAmendmentRows.length > 0;
  }

  const amendmentEntry = getAmendmentEntryState({
    bookingStatus: status,
    role: membership?.status === 'ACTIVE' ? membership.role : null,
    hasActiveAmendment,
  });

  // Items sérialisables pour les formulaires Client Components.
  const formItems: ItemProps[] = details.items.map((item) => ({
    bookingItemId: item.bookingItemId,
    internalSku: item.internalSku,
    serialNumber: item.serialNumber,
    currentCondition: item.currentCondition,
  }));

  // Clés d'idempotence générées côté serveur (une par formulaire potentiel).
  // Stable pendant les retries : la même clé est réutilisée tant que le
  // composant client n'est pas remonté.
  const transitionKey = crypto.randomUUID();
  const pickupReportKeys = formItems.map(() => crypto.randomUUID());
  const returnReportKeys = formItems.map(() => crypto.randomUUID());
  const damageReportKeys = formItems.map(() => crypto.randomUUID());

  return (
    <main>
      <p>
        <Link href={`/dashboard/${organizationId}/operations`}>← Retour aux opérations</Link>
      </p>

      <h1>Réservation — {bookingStatusLabel(status)}</h1>

      <section aria-labelledby="info-heading">
        <h2 id="info-heading">Informations</h2>
        <p>
          Lieu : {details.locationName} (fuseau : {details.locationTimeZone})
        </p>
        <p>Début : {formatDateTimeInTimeZone(details.customerStartAt, details.locationTimeZone)}</p>
        <p>Fin : {formatDateTimeInTimeZone(details.customerEndAt, details.locationTimeZone)}</p>
        <p>Email client : {details.customerEmail}</p>
      </section>

      {/* Modification de la réservation (G7M-C5-A) */}
      {amendmentEntry.reason !== 'INSUFFICIENT_ROLE' && (
        <section aria-labelledby="amendment-heading" style={{ marginBottom: '1.5rem' }}>
          <h2 id="amendment-heading">Modification de la réservation</h2>
          {amendmentEntry.canAmend ? (
            <div>
              <p>Vous pouvez ajuster les dates de location et les quantités d'articles réservés.</p>
              <Link
                href={`/dashboard/${organizationId}/operations/${bookingId}/amend`}
                style={{
                  display: 'inline-block',
                  padding: '0.5rem 1rem',
                  backgroundColor: '#2563eb',
                  color: '#ffffff',
                  borderRadius: '0.375rem',
                  textDecoration: 'none',
                  fontWeight: 500,
                }}
              >
                Modifier la réservation
              </Link>
            </div>
          ) : amendmentEntry.reason === 'ACTIVE_AMENDMENT_EXISTS' ? (
            <p>Une modification est actuellement en cours sur cette réservation.</p>
          ) : null}
        </section>
      )}

      {/* Action de transition */}
      {transitionInfo !== null && (
        <section aria-labelledby="transition-heading">
          <h2 id="transition-heading">Action de transition</h2>
          <p>{transitionInfo.helpText}</p>
          <TransitionAction
            orgId={organizationId}
            bookingId={bookingId}
            actionKind={transitionInfo.kind}
            label={transitionInfo.label}
            idempotencyKey={transitionKey}
          />
        </section>
      )}

      {readOnly && (
        <p role="status" aria-live="polite">
          Cette réservation est en lecture seule (statut : {bookingStatusLabel(status)}).
        </p>
      )}

      {/* Exemplaires */}
      <section aria-labelledby="items-heading">
        <h2 id="items-heading">Exemplaires</h2>
        <ul
          role="list"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
            listStyle: 'none',
            padding: 0,
          }}
        >
          {details.items.map((item) => (
            <li
              key={item.bookingItemId}
              style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '1rem' }}
            >
              <p style={{ fontWeight: 600 }}>{item.internalSku}</p>
              <p>Numéro de série : {item.serialNumber ?? '—'}</p>
              <p>Condition actuelle : {conditionLabel(item.currentCondition)}</p>
              <p>Statut : {item.inventoryStatus}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* Rapports d'état */}
      {(showPickupForm || showReturnForm) && (
        <section aria-labelledby="condition-reports-heading">
          <h2 id="condition-reports-heading">Rapports d'état</h2>
          {details.items.map((item, idx) => (
            <div key={item.bookingItemId} style={{ marginBottom: '1.5rem' }}>
              <h3>{item.internalSku}</h3>
              {showPickupForm && (
                <ConditionReportForm
                  orgId={organizationId}
                  bookingId={bookingId}
                  bookingItemId={item.bookingItemId}
                  phase="PICKUP"
                  idempotencyKey={pickupReportKeys[idx]!}
                  conditions={INVENTORY_CONDITIONS}
                />
              )}
              {showReturnForm && (
                <ConditionReportForm
                  orgId={organizationId}
                  bookingId={bookingId}
                  bookingItemId={item.bookingItemId}
                  phase="RETURN"
                  idempotencyKey={returnReportKeys[idx]!}
                  conditions={INVENTORY_CONDITIONS}
                />
              )}
            </div>
          ))}
        </section>
      )}

      {/* Déclarations de dommage */}
      {showDamageForm && (
        <section aria-labelledby="damage-reports-heading">
          <h2 id="damage-reports-heading">Déclarations de dommage</h2>
          <p>
            Cette déclaration enregistre le dommage sans modifier automatiquement l'état de
            l'exemplaire ni créer une maintenance.
          </p>
          {details.items.map((item, idx) => (
            <div key={item.bookingItemId} style={{ marginBottom: '1.5rem' }}>
              <h3>{item.internalSku}</h3>
              <DamageReportForm
                orgId={organizationId}
                bookingId={bookingId}
                bookingItemId={item.bookingItemId}
                idempotencyKey={damageReportKeys[idx]!}
              />
            </div>
          ))}
        </section>
      )}

      {/* Timeline fulfillment */}
      <section aria-labelledby="timeline-heading">
        <h2 id="timeline-heading">Historique des transitions</h2>
        {details.fulfillmentEvents.length === 0 ? (
          <p>Aucune transition enregistrée.</p>
        ) : (
          <ol role="list" style={{ listStyle: 'none', padding: 0 }}>
            {details.fulfillmentEvents.map((event) => (
              <li
                key={event.id}
                style={{
                  borderLeft: '3px solid #2563eb',
                  paddingLeft: '1rem',
                  marginBottom: '0.75rem',
                }}
              >
                <p style={{ fontWeight: 600 }}>{eventTypeLabel(event.eventType)}</p>
                <p>
                  {bookingStatusLabel(event.previousStatus)} →{' '}
                  {bookingStatusLabel(event.nextStatus)}
                </p>
                <p>{formatDateTimeInTimeZone(event.occurredAt, details.locationTimeZone)}</p>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Rapports d'état existants (groupés par booking_item) */}
      {details.conditionReports.length > 0 && (
        <section aria-labelledby="existing-condition-reports-heading">
          <h2 id="existing-condition-reports-heading">Rapports d'état enregistrés</h2>
          {details.items.map((item) => {
            const reports = details.conditionReports.filter(
              (r) => r.bookingItemId === item.bookingItemId,
            );
            if (reports.length === 0) return null;
            return (
              <div key={item.bookingItemId} style={{ marginBottom: '1.5rem' }}>
                <h3>{item.internalSku}</h3>
                <ul role="list">
                  {reports.map((report) => (
                    <li key={report.id}>
                      <p>Phase : {phaseLabel(report.phase)}</p>
                      <p>Condition : {conditionLabel(report.condition)}</p>
                      {report.notes && <p>Notes : {report.notes}</p>}
                      <p>{formatDateTimeInTimeZone(report.createdAt, details.locationTimeZone)}</p>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
      )}

      {/* Dommages existants (groupés par booking_item) */}
      {details.damageReports.length > 0 && (
        <section aria-labelledby="existing-damage-reports-heading">
          <h2 id="existing-damage-reports-heading">Dommages enregistrés</h2>
          {details.items.map((item) => {
            const reports = details.damageReports.filter(
              (r) => r.bookingItemId === item.bookingItemId,
            );
            if (reports.length === 0) return null;
            return (
              <div key={item.bookingItemId} style={{ marginBottom: '1.5rem' }}>
                <h3>{item.internalSku}</h3>
                <ul role="list">
                  {reports.map((report) => (
                    <li key={report.id}>
                      <p>Description : {report.description}</p>
                      <p>{formatDateTimeInTimeZone(report.createdAt, details.locationTimeZone)}</p>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
      )}
    </main>
  );
}
