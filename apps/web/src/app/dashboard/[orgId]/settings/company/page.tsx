import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getOrganizationById, getMembership, requireMembership, can } from '@uttily/core';
import { updateCompanySettingsAction } from '@/app/actions/settings';
import { CompanySettingsView } from '@/features/settings';

export default async function CompanySettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const user = await getAuthenticatedUser();
  if (!user) redirect('/sign-in');

  const db = getDb();
  const membership = await getMembership(db, orgId, user.id);
  const active = requireMembership(membership, ['OWNER', 'ADMIN', 'MANAGER', 'STAFF']);

  const organization = await getOrganizationById(db, orgId);
  if (!organization) redirect('/dashboard');

  const canManage = can(active.role, 'organization.manage');

  async function updateCompany(formData: FormData) {
    'use server';
    const publicDisplayName = String(formData.get('publicDisplayName') ?? '');
    await updateCompanySettingsAction(orgId, {
      publicDisplayName: publicDisplayName.trim().length > 0 ? publicDisplayName : null,
    });
    redirect(`/dashboard/${orgId}/settings/company`);
  }

  return (
    <CompanySettingsView
      organization={organization}
      canManage={canManage}
      updateCompany={updateCompany}
    />
  );
}
