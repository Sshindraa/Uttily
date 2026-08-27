'use server';

import { revalidatePath } from 'next/cache';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  getMembership,
  requireCapability,
  changeMemberRole,
  removeMember,
  type MembershipRole,
} from '@uttily/core';

export async function changeMemberRoleAction(
  organizationId: string,
  targetUserId: string,
  newRole: MembershipRole,
) {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');

  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  const active = requireCapability(membership, 'team.changeRole');

  await changeMemberRole(db, organizationId, targetUserId, newRole, {
    userId: user.id,
    role: active.role,
  });

  revalidatePath(`/dashboard/${organizationId}/team`);
}

export async function removeMemberAction(organizationId: string, targetUserId: string) {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');

  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  const active = requireCapability(membership, 'team.remove');

  await removeMember(db, organizationId, targetUserId, {
    userId: user.id,
    role: active.role,
  });

  revalidatePath(`/dashboard/${organizationId}/team`);
}
