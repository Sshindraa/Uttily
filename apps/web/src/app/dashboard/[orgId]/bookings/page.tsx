import { listOperationalBookings, type BookingStatus } from '@uttily/core';
import { OperationsBookingsView } from '@/features/operations';
import { requireFulfillmentOperatorOf } from '@/lib/fulfillment-auth';
import { parseStatusFilter } from '@/lib/operations-helpers';

export default async function BookingsListPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ status?: string | string[]; tab?: string }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const { db, organizationId } = await requireFulfillmentOperatorOf(orgId);

  const sp = await searchParams;
  let statuses: BookingStatus[] | null = null;
  let filterError: string | null = null;
  try {
    statuses = parseStatusFilter(sp.status);
  } catch (err) {
    filterError = err instanceof Error ? err.message : 'Filtre invalide.';
  }

  const listOptions = filterError === null && statuses !== null ? { statuses } : undefined;
  const bookings =
    filterError === null ? await listOperationalBookings(db, organizationId, listOptions) : [];

  return (
    <OperationsBookingsView
      organizationId={organizationId}
      bookings={bookings}
      status={sp.status}
      filterError={filterError}
    />
  );
}
