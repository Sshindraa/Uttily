import { redirect } from 'next/navigation';

export default async function LegacyAmendBookingPage({
  params,
}: {
  params: Promise<{ orgId: string; bookingId: string }>;
}): Promise<never> {
  const { orgId, bookingId } = await params;
  redirect(`/dashboard/${orgId}/bookings/${bookingId}/amend`);
}
