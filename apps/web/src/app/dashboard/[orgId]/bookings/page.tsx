import {
  getOperationalDeskBookings,
  getOperationalLocalCivilDate,
  listLocations,
} from '@uttily/core';
import type { OperationalDayDesk } from '@uttily/core';
import { DeskView } from '@/features/operations';
import { requireFulfillmentOperatorOf } from '@/lib/fulfillment-auth';

function firstSearchParam(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  const normalized = first?.trim();
  return normalized ? normalized : undefined;
}

export default async function BookingsListPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{
    locationId?: string | string[];
    date?: string | string[];
    search?: string | string[];
    /** Conservé pour ne pas casser les anciens liens de la route. */
    status?: string | string[];
  }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const { db, organizationId } = await requireFulfillmentOperatorOf(orgId);
  const sp = await searchParams;
  const locations = await listLocations(db, organizationId);
  const requestedLocationId = firstSearchParam(sp.locationId);
  const requestedDate = firstSearchParam(sp.date);
  const search = firstSearchParam(sp.search) ?? '';

  let filterError: string | null = null;
  let selectedLocationId = locations[0]?.id ?? null;
  if (requestedLocationId) {
    if (locations.some((location) => location.id === requestedLocationId)) {
      selectedLocationId = requestedLocationId;
    } else {
      filterError = 'Ce point de retrait n’est pas accessible dans cette organisation.';
    }
  }

  let desk: OperationalDayDesk | null = null;
  if (selectedLocationId) {
    try {
      desk = await getOperationalDeskBookings(db, organizationId, {
        locationId: selectedLocationId,
        ...(requestedDate ? { targetDate: requestedDate } : {}),
        ...(search ? { search } : {}),
      });
    } catch (error) {
      filterError = error instanceof Error ? error.message : 'Filtres invalides.';
    }
  }

  // Avec une URL vierge, le read model choisit la date civile courante du lieu.
  // Cette valeur n'est utilisée que pour garder le champ date rempli en cas de
  // réponse vide ou d'erreur de filtre.
  const selectedLocation = locations.find((location) => location.id === selectedLocationId);
  const fallbackDate = selectedLocation
    ? getOperationalLocalCivilDate(new Date(), selectedLocation.timeZone)
    : '';

  return (
    <DeskView
      organizationId={organizationId}
      locations={locations}
      desk={desk}
      selectedLocationId={selectedLocationId}
      search={search}
      filterError={filterError}
      defaultDate={desk?.targetDate ?? requestedDate ?? fallbackDate}
    />
  );
}
