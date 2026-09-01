import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  getOrganizationById,
  getMembership,
  requireMembership,
  can,
  getCancellationPolicyDefinitions,
  type CancellationPolicyCode,
} from '@uttily/core';
import { updateCancellationPolicyAction } from '@/app/actions/settings';
import { PoliciesSettingsView } from '@/features/settings';

export default async function PoliciesSettingsPage({
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

  const canManage = can(active.role, 'policy.manage');
  const policyDefinitions = getCancellationPolicyDefinitions();
  const currentPolicyCode = (organization.defaultCancellationPolicyCode ??
    'FLEXIBLE') as CancellationPolicyCode;

  async function updatePolicy(formData: FormData) {
    'use server';
    const policyCode = String(formData.get('policyCode') ?? 'FLEXIBLE') as CancellationPolicyCode;
    await updateCancellationPolicyAction(orgId, policyCode);
    redirect(`/dashboard/${orgId}/settings/policies`);
  }

  return (
    <PoliciesSettingsView
      canManage={canManage}
      currentPolicyCode={currentPolicyCode}
      policyDefinitions={policyDefinitions}
      updatePolicy={updatePolicy}
    />
  );
}
