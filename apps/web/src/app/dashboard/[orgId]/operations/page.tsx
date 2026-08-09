import Link from 'next/link';
import { listOperationalBookings, type BookingStatus } from '@uttily/core';
import { requireFulfillmentOperatorOf } from '@/lib/fulfillment-auth';
import {
  bookingStatusLabel,
  buildFilterUrl,
  formatDateTimeInTimeZone,
  QUICK_FILTERS,
  parseStatusFilter,
} from '@/lib/operations-helpers';

export default async function OperationsListPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ status?: string | string[] }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const { db, organizationId } = await requireFulfillmentOperatorOf(orgId);

  // Valide le filtre de statut depuis searchParams.
  const sp = await searchParams;
  let statuses: BookingStatus[] | null = null;
  let filterError: string | null = null;
  try {
    statuses = parseStatusFilter(sp.status);
  } catch (err) {
    filterError = err instanceof Error ? err.message : 'Filtre invalide.';
  }

  // En cas d'erreur de filtre, on ne charge PAS les bookings :
  // on affiche l'erreur sans fallback silencieux vers "toutes les réservations".
  const listOptions = filterError === null && statuses !== null ? { statuses } : undefined;
  const shouldLoadBookings = filterError === null;
  const bookings = shouldLoadBookings
    ? await listOperationalBookings(db, organizationId, listOptions)
    : [];

  // Détermine le filtre actif pour l'état visuel.
  const activeFilterKey = (() => {
    if (statuses === null) return 'all';
    // Cherche quel quick filter correspond aux statuts sélectionnés.
    for (const qf of QUICK_FILTERS) {
      if (
        qf.statuses.length === statuses.length &&
        qf.statuses.every((s) => statuses!.includes(s))
      ) {
        return qf.key;
      }
    }
    return 'custom';
  })();

  return (
    <main>
      <h1>Opérations</h1>

      {/* Filtres rapides */}
      <nav aria-label="Filtres des opérations">
        <ul
          role="list"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.5rem',
            listStyle: 'none',
            padding: 0,
          }}
        >
          {QUICK_FILTERS.map((qf) => {
            const isActive = activeFilterKey === qf.key;
            const href = buildFilterUrl(organizationId, qf);
            return (
              <li key={qf.key}>
                <Link
                  href={href}
                  aria-current={isActive ? 'page' : undefined}
                  style={{
                    display: 'inline-block',
                    padding: '0.375rem 0.75rem',
                    borderRadius: 6,
                    border: isActive ? '2px solid #2563eb' : '1px solid #d1d5db',
                    fontWeight: isActive ? 600 : 400,
                    textDecoration: 'none',
                    color: isActive ? '#2563eb' : '#374151',
                  }}
                >
                  {qf.label}
                  {isActive && <span aria-hidden="true"> ✓</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {filterError && (
        <p role="alert" style={{ color: '#dc2626' }}>
          {filterError}
        </p>
      )}

      {!filterError && (
        <>
          {bookings.length === 0 ? (
            <p>
              {statuses !== null
                ? 'Aucune réservation ne correspond à ce filtre.'
                : 'Aucune réservation à traiter pour le moment.'}
            </p>
          ) : (
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
              {bookings.map((booking) => (
                <li
                  key={booking.id}
                  style={{
                    border: '1px solid #e5e7eb',
                    borderRadius: 8,
                    padding: '1rem',
                  }}
                >
                  <p style={{ fontWeight: 600, fontSize: '1.125rem' }}>
                    {bookingStatusLabel(booking.status)}
                  </p>
                  <p>Lieu : {booking.locationName}</p>
                  <p>
                    Début :{' '}
                    {formatDateTimeInTimeZone(booking.customerStartAt, booking.locationTimeZone)}
                  </p>
                  <p>
                    Fin :{' '}
                    {formatDateTimeInTimeZone(booking.customerEndAt, booking.locationTimeZone)}
                  </p>
                  <p>Exemplaires : {booking.bookingItemCount}</p>
                  <p>
                    Rapports d'état : {booking.conditionReportCount} — Dommages :{' '}
                    {booking.damageReportCount}
                  </p>
                  <p>
                    <Link href={`/dashboard/${organizationId}/operations/${booking.id}`}>
                      Ouvrir la réservation
                    </Link>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
