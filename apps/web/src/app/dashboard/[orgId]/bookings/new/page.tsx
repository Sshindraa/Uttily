import { notFound } from 'next/navigation';
import { listLocations, getCounterAvailableItems } from '@uttily/core';
import { EmptyState, LinkButton } from '@uttily/ui';
import { requireFulfillmentOperatorOf } from '@/lib/fulfillment-auth';
import { CounterBookingView } from '@/features/operations/counter-booking-view';

function firstSearchParam(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  const normalized = first?.trim();
  return normalized ? normalized : undefined;
}

export default async function NewCounterBookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ locationId?: string | string[] }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const { db, user, organizationId } = await requireFulfillmentOperatorOf(orgId);
  const sp = await searchParams;
  const locations = await listLocations(db, organizationId);

  if (locations.length === 0) {
    return (
      <div style={{ maxWidth: '640px', margin: '3rem auto', padding: '0 1rem' }}>
        <EmptyState
          title="Aucun point de retrait configuré"
          description="Pour enregistrer une réservation au comptoir, vous devez d'abord configurer au moins un point de retrait ou établissement pour votre organisation."
          action={
            <LinkButton href={`/dashboard/${organizationId}/locations/new`} variant="primary">
              Ajouter un établissement →
            </LinkButton>
          }
        />
      </div>
    );
  }

  const requestedLocationId = firstSearchParam(sp.locationId);
  const initialLocation = locations.find((l) => l.id === requestedLocationId) ?? locations[0];

  if (!initialLocation) {
    notFound();
  }

  // Période par défaut : maintenant arrondi aux 15 min -> +2 heures
  const now = new Date();
  now.setMinutes(Math.ceil(now.getMinutes() / 15) * 15, 0, 0);
  const startAt = new Date(now);
  const endAt = new Date(startAt.getTime() + 2 * 3600_000);

  const initialData = await getCounterAvailableItems(db, {
    organizationId,
    locationId: initialLocation.id,
    operator: user,
    startAt,
    endAt,
  });

  return (
    <CounterBookingView
      organizationId={organizationId}
      locations={locations.map((l) => ({
        id: l.id,
        name: l.name,
        timeZone: l.timeZone,
      }))}
      initialLocationId={initialLocation.id}
      initialItems={initialData.items}
      defaultStartIso={startAt.toISOString()}
      defaultEndIso={endAt.toISOString()}
    />
  );
}
