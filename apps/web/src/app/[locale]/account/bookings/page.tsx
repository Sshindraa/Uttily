import { redirect } from 'next/navigation';
import { listCustomerBookings } from '@uttily/core';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { BookingsListView } from '@/features/bookings';

export const dynamic = 'force-dynamic';

export default async function CustomerBookingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale } = await params;
  const user = await getAuthenticatedUser();
  if (!user) {
    redirect(`/sign-in?redirect_url=${encodeURIComponent(`/${locale}/account/bookings`)}`);
  }

  const db = getDb();
  const bookings = await listCustomerBookings(db, user.id);

  return <BookingsListView locale={locale} bookings={bookings} />;
}
