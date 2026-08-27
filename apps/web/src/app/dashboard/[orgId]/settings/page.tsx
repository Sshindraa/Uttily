import { redirect } from 'next/navigation';

export default async function SettingsIndexPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<never> {
  const { orgId } = await params;
  redirect(`/dashboard/${orgId}/settings/company`);
}
