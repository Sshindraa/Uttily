import { redirect } from 'next/navigation';

export default async function LegacyOperationsDetailRedirect({
  params,
}: {
  params: Promise<{ orgId: string; bookingId: string }>;
}): Promise<never> {
  const { orgId, bookingId } = await params;
  redirect(`/dashboard/${orgId}/bookings/${bookingId}`);
}
