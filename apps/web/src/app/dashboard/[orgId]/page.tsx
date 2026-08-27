import {
  listLocations,
  listMaintenanceDashboardSignals,
  listPendingInvitations,
  getOrganizationOnboardingReadiness,
  type MaintenanceDashboardSignal,
} from '@uttily/core';
import { requireFulfillmentOperatorOf } from '@/lib/fulfillment-auth';
import { formatDateTimeInTimeZone } from '@/lib/operations-helpers';
import Link from 'next/link';
import { OnboardingReadinessCard } from './onboarding-readiness-card';

function maintenanceSignalLabel(kind: MaintenanceDashboardSignal['kind']): string {
  switch (kind) {
    case 'BROKEN_ITEM':
      return 'Matériel cassé';
    case 'ACTIVE_MAINTENANCE':
      return 'Maintenance active';
    case 'UPCOMING_MAINTENANCE':
      return 'Maintenance à venir';
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

// Page d'accueil du dashboard organisation.
// Le layout vérifie déjà l'authentification et la membership ; la page refait
// la vérification via le contexte fulfillment pour ses lectures sensibles.
export default async function OrganizationDashboardPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const { db, organizationId } = await requireFulfillmentOperatorOf(orgId);
  const asOf = new Date();
  const readiness = await getOrganizationOnboardingReadiness(db, organizationId);
  const locations = await listLocations(db, organizationId);
  const invitations = await listPendingInvitations(db, organizationId);
  const maintenanceSignals = await listMaintenanceDashboardSignals(db, organizationId, { asOf });

  return (
    <>
      <h1>Organisation</h1>

      <OnboardingReadinessCard orgId={organizationId} readiness={readiness} />

      <section aria-labelledby="maintenance-signals-heading">
        <h2 id="maintenance-signals-heading">
          Alertes matériel et maintenance ({maintenanceSignals.length})
        </h2>
        {maintenanceSignals.length === 0 ? (
          <p>Aucune alerte de matériel ou de maintenance.</p>
        ) : (
          <ul aria-label="Alertes de matériel et de maintenance">
            {maintenanceSignals.map((signal) => {
              const signalId =
                signal.kind === 'BROKEN_ITEM'
                  ? `broken-${signal.inventoryItemId}`
                  : `${signal.kind.toLowerCase()}-${signal.maintenanceBlockId}`;
              const signalLabel = maintenanceSignalLabel(signal.kind);

              return (
                <li key={signalId}>
                  <article aria-labelledby={`${signalId}-heading`}>
                    <p>
                      <strong>{signalLabel}</strong>
                    </p>
                    <h3 id={`${signalId}-heading`}>
                      <Link
                        href={`/dashboard/${organizationId}/inventory/${signal.inventoryItemId}`}
                      >
                        {signal.productName} — {signal.variantName}
                      </Link>
                    </h3>
                    <p>Exemplaire : {signal.internalSku}</p>
                    <p>
                      Lieu : {signal.locationName} — fuseau IANA :{' '}
                      <code>{signal.locationTimeZone}</code>
                    </p>
                    <p>
                      Signal évalué le {formatDateTimeInTimeZone(asOf, signal.locationTimeZone)} (
                      {signal.locationTimeZone}).
                    </p>
                    {signal.kind === 'BROKEN_ITEM' ? (
                      <p>État physique : BROKEN (cassé).</p>
                    ) : (
                      <p>
                        {signal.kind === 'ACTIVE_MAINTENANCE'
                          ? 'Période de maintenance en cours'
                          : 'Période de maintenance à venir'}{' '}
                        : du{' '}
                        {formatDateTimeInTimeZone(signal.blockedStartAt, signal.locationTimeZone)}{' '}
                        au {formatDateTimeInTimeZone(signal.blockedEndAt, signal.locationTimeZone)}{' '}
                        ({signal.locationTimeZone}).
                      </p>
                    )}
                  </article>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h2>Établissements ({locations.length})</h2>
        {locations.length === 0 ? (
          <p>
            Aucun établissement. <Link href={`/dashboard/${orgId}/locations/new`}>Ajouter</Link>.
          </p>
        ) : (
          <ul>
            {locations.map((loc) => (
              <li key={loc.id}>
                <Link href={`/dashboard/${orgId}/locations/${loc.id}`}>{loc.name}</Link>
                {' — '}
                {loc.timeZone}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Invitations en attente ({invitations.length})</h2>
        {invitations.length === 0 ? (
          <p>Aucune invitation en attente.</p>
        ) : (
          <ul>
            {invitations.map((inv) => (
              <li key={inv.id}>
                {inv.email} — {inv.role}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
