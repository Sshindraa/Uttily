import { notFound } from 'next/navigation';
import { getOperationalBookingDetails } from '@uttily/core';
import { BookingDetailView } from '@/features/operations';
import { requireFulfillmentOperatorOf } from '@/lib/fulfillment-auth';
import { isValidUuid } from '@/lib/operations-helpers';

export default async function UnifiedBookingDetailPage({
  params,
}: {
  params: Promise<{ orgId: string; bookingId: string }>;
}): Promise<React.ReactElement> {
  const { orgId, bookingId } = await params;

  if (!isValidUuid(bookingId)) notFound();

  const { db, organizationId } = await requireFulfillmentOperatorOf(orgId);
  const details = await getOperationalBookingDetails(db, organizationId, bookingId);
  if (details === null) notFound();

  return (
    <BookingDetailView organizationId={organizationId} bookingId={bookingId} details={details} />
  );
}
