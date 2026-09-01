import { notFound } from 'next/navigation';
import { getBookingSupportDetails, SupportBookingNotFoundError } from '@uttily/core';
import { BookingSupportView } from '@/features/internal';
import { requireSupportPlatformAdmin } from '@/lib/support-auth';

export const dynamic = 'force-dynamic';

export default async function BookingSupportPage({
  params,
}: {
  params: Promise<{ bookingId: string }>;
}) {
  const { db } = await requireSupportPlatformAdmin();
  const { bookingId } = await params;

  try {
    const booking = await getBookingSupportDetails(db, bookingId);
    return <BookingSupportView booking={booking} />;
  } catch (err) {
    if (err instanceof SupportBookingNotFoundError) {
      notFound();
    }
    throw err;
  }
}
