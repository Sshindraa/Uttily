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
import { createInvitationAction, revokeInvitationAction } from '@/app/actions/invitations';
import { changeMemberRoleAction, removeMemberAction } from '@/app/actions/team';

const ROLE_LABELS: Record<MembershipRole, string> = {
  OWNER: 'Propriétaire',
  ADMIN: 'Administrateur',
  MANAGER: 'Responsable',
  STAFF: 'Membre',
};

const ROLE_DESCRIPTIONS: Record<MembershipRole, string> = {
  OWNER: 'Accès complet, gestion de l’organisation, des finances et des rôles.',
  ADMIN: 'Gestion des opérations, de la flotte, des magasins et invitations.',
  MANAGER: 'Gestion des opérations, de la flotte et des magasins.',
  STAFF: 'Gestion des réservations, départs et retours.',
};

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

  // Charger les membres avec les adresses email réelles depuis la table users
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

  // Charger les invitations en attente
  const pendingInvitations = await listPendingInvitations(db, orgId);

  const canInvite = can(active.role, 'team.invite');
  const canChangeRole = can(active.role, 'team.changeRole');
  const canRemove = can(active.role, 'team.remove');

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
    <div style={containerStyle}>
      <header style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Équipe</h1>
          <p style={subtitleStyle}>
            Gérez les collaborateurs de votre organisation et leurs niveaux d’accès.
          </p>
        </div>
      </header>

      <div style={gridStyle}>
        {/* Colonne liste des membres */}
        <section aria-labelledby="members-heading" style={cardStyle}>
          <h2 id="members-heading" style={cardTitleStyle}>
            Membres actifs ({memberRows.length})
          </h2>

          <div style={membersListStyle}>
            {memberRows.map((m) => {
              const isCurrentUser = m.userId === user.id;
              const isTargetOwner = m.role === 'OWNER';
              const isTargetAdmin = m.role === 'ADMIN';

              // ADMIN ne peut pas retirer un OWNER ou un autre ADMIN
              const canRemoveTarget =
                canRemove &&
                !isCurrentUser &&
                (active.role === 'OWNER' || (!isTargetOwner && !isTargetAdmin));

              return (
                <div key={m.userId} style={memberRowStyle}>
                  <div style={memberInfoStyle}>
                    <div style={memberHeaderRowStyle}>
                      <strong style={memberEmailStyle}>{m.email}</strong>
                      {isCurrentUser && <span style={selfBadgeStyle}>Vous</span>}
                    </div>
                    <div style={roleBadgeRowStyle}>
                      <span style={getRoleBadgeStyle(m.role)}>{ROLE_LABELS[m.role]}</span>
                      <span style={roleDescStyle}>{ROLE_DESCRIPTIONS[m.role]}</span>
                    </div>
                  </div>

                  <div style={memberActionsStyle}>
                    {canChangeRole && !isCurrentUser && (
                      <form action={updateMemberRole} style={inlineFormStyle}>
                        <input type="hidden" name="targetUserId" value={m.userId} />
                        <select
                          name="newRole"
                          defaultValue={m.role}
                          aria-label={`Changer le rôle de ${m.email}`}
                          style={selectStyle}
                        >
                          <option value="OWNER">Propriétaire</option>
                          <option value="ADMIN">Administrateur</option>
                          <option value="MANAGER">Responsable</option>
                          <option value="STAFF">Membre</option>
                        </select>
                        <button type="submit" style={secondaryButtonStyle}>
                          Modifier
                        </button>
                      </form>
                    )}

                    {canRemoveTarget && (
                      <form action={deleteMember} style={inlineFormStyle}>
                        <input type="hidden" name="targetUserId" value={m.userId} />
                        <button
                          type="submit"
                          style={dangerButtonStyle}
                          aria-label={`Retirer ${m.email}`}
                        >
                          Retirer
                        </button>
                      </form>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Colonne latérale : Invitations & Formulaire d'invitation */}
        <aside style={sidebarStyle}>
          {canInvite && (
            <section aria-labelledby="invite-heading" style={cardStyle}>
              <h2 id="invite-heading" style={cardTitleStyle}>
                Inviter un collaborateur
              </h2>
              <form action={inviteMember} style={formStyle}>
                <div style={formGroupStyle}>
                  <label htmlFor="email" style={labelStyle}>
                    Adresse email
                  </label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    required
                    placeholder="collaborateur@exemple.com"
                    style={inputStyle}
                  />
                </div>

                <div style={formGroupStyle}>
                  <label htmlFor="role" style={labelStyle}>
                    Rôle attribué
                  </label>
                  <select id="role" name="role" defaultValue="STAFF" style={inputStyle}>
                    {active.role === 'OWNER' && <option value="ADMIN">Administrateur</option>}
                    <option value="MANAGER">Responsable</option>
                    <option value="STAFF">Membre</option>
                  </select>
                </div>

                <button type="submit" style={primaryButtonStyle}>
                  Envoyer l’invitation
                </button>
              </form>
            </section>
          )}

          {/* Invitations en attente */}
          <section aria-labelledby="pending-heading" style={cardStyle}>
            <h2 id="pending-heading" style={cardTitleStyle}>
              Invitations en attente ({pendingInvitations.length})
            </h2>

            {pendingInvitations.length === 0 ? (
              <p style={emptyTextStyle}>Aucune invitation en cours.</p>
            ) : (
              <div style={invitationsListStyle}>
                {pendingInvitations.map((inv) => {
                  const daysLeft = Math.max(
                    0,
                    Math.ceil(
                      (new Date(inv.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
                    ),
                  );

                  return (
                    <div key={inv.id} style={invitationRowStyle}>
                      <div>
                        <strong style={invEmailStyle}>{inv.email}</strong>
                        <div style={invMetaStyle}>
                          <span style={getRoleBadgeStyle(inv.role)}>{ROLE_LABELS[inv.role]}</span>
                          <span style={invExpiryStyle}>
                            {daysLeft > 0
                              ? `Expire dans ${daysLeft} jour${daysLeft > 1 ? 's' : ''}`
                              : 'Expire bientôt'}
                          </span>
                        </div>
                      </div>

                      {canInvite && (
                        <form action={revokeInvitation}>
                          <input type="hidden" name="invitationId" value={inv.id} />
                          <button type="submit" style={revokeBtnStyle}>
                            Révoquer
                          </button>
                        </form>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function getRoleBadgeStyle(role: MembershipRole): React.CSSProperties {
  switch (role) {
    case 'OWNER':
      return {
        display: 'inline-block',
        padding: '0.2rem 0.5rem',
        borderRadius: '9999px',
        fontSize: '0.75rem',
        fontWeight: 600,
        backgroundColor: '#e0e7ff',
        color: '#3730a3',
      };
    case 'ADMIN':
      return {
        display: 'inline-block',
        padding: '0.2rem 0.5rem',
        borderRadius: '9999px',
        fontSize: '0.75rem',
        fontWeight: 600,
        backgroundColor: '#fef3c7',
        color: '#92400e',
      };
    case 'MANAGER':
      return {
        display: 'inline-block',
        padding: '0.2rem 0.5rem',
        borderRadius: '9999px',
        fontSize: '0.75rem',
        fontWeight: 600,
        backgroundColor: '#e0f2fe',
        color: '#0369a1',
      };
    case 'STAFF':
    default:
      return {
        display: 'inline-block',
        padding: '0.2rem 0.5rem',
        borderRadius: '9999px',
        fontSize: '0.75rem',
        fontWeight: 600,
        backgroundColor: '#f1f5f9',
        color: '#475569',
      };
  }
}

const containerStyle: React.CSSProperties = {
  maxWidth: '1200px',
  margin: '0 auto',
  padding: '1.5rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '1.5rem',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
};

const titleStyle: React.CSSProperties = {
  fontSize: '1.75rem',
  fontWeight: 700,
  color: '#0f172a',
  margin: 0,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: '0.95rem',
  color: '#64748b',
  margin: '0.25rem 0 0',
};

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 380px',
  gap: '1.5rem',
  alignItems: 'start',
};

const sidebarStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1.5rem',
};

const cardStyle: React.CSSProperties = {
  backgroundColor: '#ffffff',
  borderRadius: '12px',
  border: '1px solid #e2e8f0',
  padding: '1.5rem',
  boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05)',
};

const cardTitleStyle: React.CSSProperties = {
  fontSize: '1.1rem',
  fontWeight: 600,
  color: '#0f172a',
  margin: '0 0 1.25rem',
};

const membersListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
};

const memberRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '1rem',
  borderRadius: '8px',
  backgroundColor: '#f8fafc',
  border: '1px solid #f1f5f9',
};

const memberInfoStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.35rem',
};

const memberHeaderRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
};

const memberEmailStyle: React.CSSProperties = {
  fontSize: '0.95rem',
  color: '#0f172a',
};

const selfBadgeStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  padding: '0.1rem 0.4rem',
  borderRadius: '4px',
  backgroundColor: '#e2e8f0',
  color: '#475569',
  fontWeight: 500,
};

const roleBadgeRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
};

const roleDescStyle: React.CSSProperties = {
  fontSize: '0.8rem',
  color: '#64748b',
};

const memberActionsStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
};

const inlineFormStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.4rem',
};

const formStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
};

const formGroupStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.35rem',
};

const labelStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  fontWeight: 600,
  color: '#334155',
};

const inputStyle: React.CSSProperties = {
  padding: '0.5rem 0.75rem',
  borderRadius: '6px',
  border: '1px solid #cbd5e1',
  fontSize: '0.9rem',
};

const selectStyle: React.CSSProperties = {
  padding: '0.4rem 0.6rem',
  borderRadius: '6px',
  border: '1px solid #cbd5e1',
  fontSize: '0.85rem',
  backgroundColor: '#ffffff',
};

const primaryButtonStyle: React.CSSProperties = {
  padding: '0.6rem 1rem',
  backgroundColor: '#2563eb',
  color: '#ffffff',
  border: 'none',
  borderRadius: '6px',
  fontSize: '0.9rem',
  fontWeight: 600,
  cursor: 'pointer',
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: '0.4rem 0.6rem',
  backgroundColor: '#ffffff',
  color: '#334155',
  border: '1px solid #cbd5e1',
  borderRadius: '6px',
  fontSize: '0.85rem',
  fontWeight: 500,
  cursor: 'pointer',
};

const dangerButtonStyle: React.CSSProperties = {
  padding: '0.4rem 0.6rem',
  backgroundColor: '#fee2e2',
  color: '#991b1b',
  border: '1px solid #fecaca',
  borderRadius: '6px',
  fontSize: '0.85rem',
  fontWeight: 500,
  cursor: 'pointer',
};

const emptyTextStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  color: '#64748b',
  margin: 0,
};

const invitationsListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
};

const invitationRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '0.75rem',
  borderRadius: '6px',
  backgroundColor: '#f8fafc',
  border: '1px solid #f1f5f9',
};

const invEmailStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  color: '#0f172a',
};

const invMetaStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.4rem',
  marginTop: '0.25rem',
};

const invExpiryStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  color: '#64748b',
};

const revokeBtnStyle: React.CSSProperties = {
  padding: '0.3rem 0.5rem',
  backgroundColor: 'transparent',
  color: '#dc2626',
  border: 'none',
  fontSize: '0.8rem',
  fontWeight: 500,
  cursor: 'pointer',
};
