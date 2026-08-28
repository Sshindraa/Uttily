import { redirect } from 'next/navigation';

export default async function LegacyInventoryNewRedirect({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<never> {
  const { orgId } = await params;
  redirect(`/dashboard/${orgId}/fleet`);
}
