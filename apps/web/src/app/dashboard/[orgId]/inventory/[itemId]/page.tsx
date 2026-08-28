import { redirect } from 'next/navigation';

export default async function LegacyInventoryItemRedirect({
  params,
}: {
  params: Promise<{ orgId: string; itemId: string }>;
}): Promise<never> {
  const { orgId } = await params;
  redirect(`/dashboard/${orgId}/fleet`);
}
