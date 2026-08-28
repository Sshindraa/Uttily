import { redirect } from 'next/navigation';

export default async function LegacyCatalogNewRedirect({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<never> {
  const { orgId } = await params;
  redirect(`/dashboard/${orgId}/bikes/new`);
}
