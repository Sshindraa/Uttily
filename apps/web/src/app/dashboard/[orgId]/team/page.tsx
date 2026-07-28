import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  getMembership,
  requireMembership,
  listMembers,
  MEMBER_INVITERS,
  type MembershipRole,
} from '@uttily/core';
import { createInvitationAction } from '@/app/actions/invitations';

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
  const members = await listMembers(db, orgId);
  const canInvite = MEMBER_INVITERS.includes(active.role);

  async function inviteMember(formData: FormData) {
    'use server';
    const email = String(formData.get('email') ?? '');
    const role = String(formData.get('role') ?? 'STAFF') as MembershipRole;
    await createInvitationAction(orgId, email, role);
    redirect(`/dashboard/${orgId}/team`);
  }

  return (
    <main>
      <h1>Équipe</h1>
      <ul>
        {members.map((m) => (
          <li key={m.userId}>
            {m.userId} — {m.role} ({m.status})
          </li>
        ))}
      </ul>

      {canInvite && (
        <section>
          <h2>Inviter un membre</h2>
          <form action={inviteMember}>
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" required />

            <label htmlFor="role">Rôle</label>
            <select id="role" name="role" defaultValue="STAFF">
              {active.role === 'OWNER' && <option value="ADMIN">ADMIN</option>}
              <option value="MANAGER">MANAGER</option>
              <option value="STAFF">STAFF</option>
            </select>

            <button type="submit">Inviter</button>
          </form>
        </section>
      )}
    </main>
  );
}
