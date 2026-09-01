import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { organizationMemberships, users } from '@uttily/database';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  getMembership,
  requireMembership,
  can,
  listPendingInvitations,
  type MembershipRole,
} from '@uttily/core';
import { TeamView, getInvitableRoles } from '@/features/team';
import { createInvitationAction, revokeInvitationAction } from '@/app/actions/invitations';
import { changeMemberRoleAction, removeMemberAction } from '@/app/actions/team';

export default async function TeamPage({
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

  const memberRows = await db
    .select({
      userId: organizationMemberships.userId,
      role: organizationMemberships.role,
      status: organizationMemberships.status,
      email: users.email,
    })
    .from(organizationMemberships)
    .innerJoin(users, eq(organizationMemberships.userId, users.id))
    .where(
      and(
        eq(organizationMemberships.organizationId, orgId),
        eq(organizationMemberships.status, 'ACTIVE'),
      ),
    );

  const pendingInvitations = await listPendingInvitations(db, orgId);

  const canInvite = can(active.role, 'team.invite');
  const canChangeRole = can(active.role, 'team.changeRole');
  const canRemove = can(active.role, 'team.remove');
  const invitableRoles = getInvitableRoles(active.role);

  async function inviteMember(formData: FormData) {
    'use server';
    const email = String(formData.get('email') ?? '');
    const role = String(formData.get('role') ?? 'STAFF') as MembershipRole;
    await createInvitationAction(orgId, email, role);
    redirect(`/dashboard/${orgId}/team`);
  }

  async function updateMemberRole(formData: FormData) {
    'use server';
    const targetUserId = String(formData.get('targetUserId') ?? '');
    const newRole = String(formData.get('newRole') ?? 'STAFF') as MembershipRole;
    await changeMemberRoleAction(orgId, targetUserId, newRole);
    redirect(`/dashboard/${orgId}/team`);
  }

  async function deleteMember(formData: FormData) {
    'use server';
    const targetUserId = String(formData.get('targetUserId') ?? '');
    await removeMemberAction(orgId, targetUserId);
    redirect(`/dashboard/${orgId}/team`);
  }

  async function revokeInvitation(formData: FormData) {
    'use server';
    const invitationId = String(formData.get('invitationId') ?? '');
    await revokeInvitationAction(orgId, invitationId);
    redirect(`/dashboard/${orgId}/team`);
  }

  return (
    <TeamView
      currentUserId={user.id}
      currentUserRole={active.role}
      memberRows={memberRows}
      pendingInvitations={pendingInvitations}
      canInvite={canInvite}
      canChangeRole={canChangeRole}
      canRemove={canRemove}
      invitableRoles={invitableRoles}
      inviteMember={inviteMember}
      updateMemberRole={updateMemberRole}
      deleteMember={deleteMember}
      revokeInvitation={revokeInvitation}
    />
  );
}
