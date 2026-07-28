import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { type MembershipRole } from '@uttily/core';
import { eq, and } from 'drizzle-orm';
import { organizationInvitations } from '@uttily/database';
import { acceptInvitationAction } from '@/app/actions/invitations';

export default async function InvitationsPage(): Promise<React.ReactElement> {
  const user = await getAuthenticatedUser();
  if (!user) redirect('/sign-in');
  const db = getDb();
  // Liste les invitations en attente pour l'email de l'utilisateur courant.
  const invitations = await db
    .select()
    .from(organizationInvitations)
    .where(
      and(
        eq(organizationInvitations.email, user.email),
        eq(organizationInvitations.status, 'PENDING'),
      ),
    );

  async function accept(formData: FormData) {
    'use server';
    const token = String(formData.get('token') ?? '');
    await acceptInvitationAction(token);
    redirect('/dashboard');
  }

  return (
    <main>
      <h1>Invitations</h1>
      {invitations.length > 0 && (
        <section>
          <h2>Invitations en attente pour {user.email}</h2>
          <ul>
            {invitations.map((inv) => (
              <li key={inv.id}>
                Organisation {inv.organizationId} — rôle: {inv.role as MembershipRole}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>Accepter une invitation</h2>
        <p>Saisissez le token reçu par email.</p>
        <form action={accept}>
          <label htmlFor="token">Token d\u2019invitation</label>
          <input id="token" name="token" type="text" required />
          <button type="submit">Accepter</button>
        </form>
      </section>
    </main>
  );
}
