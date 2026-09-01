import { notFound, redirect } from 'next/navigation';
import { getCustomerBooking } from '@uttily/core';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { BookingDetailView } from '@/features/bookings';

export const dynamic = 'force-dynamic';

export default async function CustomerBookingDetailPage({
  params,
}: {
  params: Promise<{ locale: string; bookingId: string }>;
}): Promise<React.ReactElement> {
  const { locale, bookingId } = await params;
  const user = await getAuthenticatedUser();
  if (!user) {
    redirect(
      `/sign-in?redirect_url=${encodeURIComponent(`/${locale}/account/bookings/${bookingId}`)}`,
    );
  }

  const db = getDb();
  const booking = await getCustomerBooking(db, user.id, bookingId);
  if (!booking) notFound();

  return <BookingDetailView locale={locale} booking={booking} />;
}
