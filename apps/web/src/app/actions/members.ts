'use server';

import { revalidatePath } from 'next/cache';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  getMembership,
  requireMembership,
  MEMBER_INVITERS,
  ROLE_MANAGERS,
  listMembers,
  changeMemberRole,
  removeMember,
  countActiveOwners,
  type MembershipRole,
} from '@uttily/core';

export async function listMembersAction(organizationId: string) {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');
  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  requireMembership(membership, ['OWNER', 'ADMIN', 'MANAGER', 'STAFF']);
  return listMembers(db, organizationId);
}

export async function changeMemberRoleAction(
  organizationId: string,
  targetUserId: string,
  newRole: MembershipRole,
) {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');
  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  const active = requireMembership(membership, ROLE_MANAGERS);
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
  const active = requireMembership(membership, MEMBER_INVITERS);
  await removeMember(db, organizationId, targetUserId, {
    userId: user.id,
    role: active.role,
  });
  revalidatePath(`/dashboard/${organizationId}/team`);
}

export async function countOwnersAction(organizationId: string): Promise<number> {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');
  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  requireMembership(membership, ['OWNER']);
  return countActiveOwners(db, organizationId);
}
