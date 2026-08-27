'use server';

import { revalidatePath } from 'next/cache';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  getMembership,
  requireCapability,
  updateOrganizationPublicSettings,
  updateOrganizationCancellationPolicy,
  type CancellationPolicyCode,
} from '@uttily/core';

export async function updateCompanySettingsAction(
  organizationId: string,
  input: { publicDisplayName?: string | null },
) {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');

  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  requireCapability(membership, 'organization.manage');

  const org = await updateOrganizationPublicSettings(db, organizationId, input);
  revalidatePath(`/dashboard/${organizationId}/settings/company`);
  return { organization: org };
}

export async function updateCancellationPolicyAction(
  organizationId: string,
  policyCode: CancellationPolicyCode,
) {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');

  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  requireCapability(membership, 'policy.manage');

  const org = await updateOrganizationCancellationPolicy(db, organizationId, policyCode);
  revalidatePath(`/dashboard/${organizationId}/settings/policies`);
  return { organization: org };
}
