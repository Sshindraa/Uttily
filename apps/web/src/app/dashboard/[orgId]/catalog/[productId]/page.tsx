import { redirect } from 'next/navigation';

export default async function LegacyCatalogProductRedirect({
  params,
}: {
  params: Promise<{ orgId: string; productId: string }>;
}): Promise<never> {
  const { orgId, productId } = await params;
  redirect(`/dashboard/${orgId}/bikes/${productId}`);
}
