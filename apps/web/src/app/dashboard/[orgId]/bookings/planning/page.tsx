import { getOperationalItemCalendar, getOperationalPlanning, listLocations } from '@uttily/core';
import { requireFulfillmentOperatorOf } from '@/lib/fulfillment-auth';
import { isValidUuid } from '@/lib/operations-helpers';
import { PlanningView } from '@/features/planning';

/**
 * Planning opérationnel — intégré à la section **Réservations** (Chantier 17).
 *
 * IA Pro définitive : le planning n'est pas une destination top-level ; il est
 * atteint depuis Réservations (onglet « Planning ») et via la redirection de
 * l'ancienne URL `/dashboard/[orgId]/planning`.
 */
export default async function BookingPlanningPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams?: Promise<{
    locationId?: string;
    from?: string;
    to?: string;
    inventoryItemId?: string;
  }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const sp = (await searchParams) ?? {};

  const { db, organizationId } = await requireFulfillmentOperatorOf(orgId);
  const locations = await listLocations(db, organizationId);

  const selectedLocationId = sp.locationId ?? locations[0]?.id ?? null;
  const fromDate = sp.from ? new Date(sp.from) : undefined;
  const toDate = sp.to ? new Date(sp.to) : undefined;
  const requestedItemId = sp.inventoryItemId?.trim() || null;
  const validItemId = requestedItemId && isValidUuid(requestedItemId) ? requestedItemId : null;

  const [planning, selectedItemCalendar] = await Promise.all([
    getOperationalPlanning(db, organizationId, {
      locationId: selectedLocationId ?? undefined,
      from: fromDate,
      to: toDate,
    }),
    validItemId
      ? getOperationalItemCalendar(db, organizationId, validItemId, {
          locationId: selectedLocationId ?? undefined,
          from: fromDate,
          to: toDate,
        })
      : Promise.resolve(null),
  ]);

  return (
    <PlanningView
      orgId={organizationId}
      planning={planning}
      locations={locations.map((l) => ({ id: l.id, name: l.name }))}
      selectedLocationId={selectedLocationId}
      selectedItemCalendar={selectedItemCalendar}
      selectedItemCalendarError={requestedItemId !== null && selectedItemCalendar === null}
    />
  );
}
