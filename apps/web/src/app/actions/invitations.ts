'use server';

import { revalidatePath } from 'next/cache';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  getMembership,
  requireMembership,
  MEMBER_INVITERS,
  createInvitation,
  listPendingInvitations,
  revokeInvitation,
  acceptInvitation,
  expireDueInvitations,
  DEFAULT_INVITATION_TTL_SECONDS,
  type MembershipRole,
} from '@uttily/core';

export async function createInvitationAction(
  organizationId: string,
  email: string,
  role: MembershipRole,
) {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');
  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  const active = requireMembership(membership, MEMBER_INVITERS);
  const invitation = await createInvitation(
    db,
    { id: user.id, role: active.role },
    {
      organizationId,
      email,
      role,
      invitedBy: user.id,
      ttlSeconds: DEFAULT_INVITATION_TTL_SECONDS,
    },
  );
  revalidatePath(`/dashboard/${organizationId}/team`);
  // Le token n'est renvoyé qu'une seule fois à l'appelant.
  return {
    id: invitation.id,
    token: invitation.token,
    email: invitation.email,
    role: invitation.role,
  };
}

export async function listPendingInvitationsAction(organizationId: string) {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');
  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  requireMembership(membership, ['OWNER', 'ADMIN', 'MANAGER', 'STAFF']);
  return listPendingInvitations(db, organizationId);
}

export async function revokeInvitationAction(invitationId: string) {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');
  const db = getDb();
  await revokeInvitation(db, invitationId, user.id);
  revalidatePath('/invitations');
}

export async function acceptInvitationAction(token: string) {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');
  const db = getDb();
  const result = await acceptInvitation(db, user, token);
  revalidatePath('/dashboard');
  return result;
}

export async function expireInvitationsAction(): Promise<number> {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('Non authentifié.');
  const db = getDb();
  // Action réservée à l'admin Uttily ou au worker dans une version future.
  if (!user.isPlatformAdmin) throw new Error('Action réservée à l\u2019admin Uttily.');
  return expireDueInvitations(db);
}
