import { canInviteRole, type MembershipRole, type MembershipStatus } from '@uttily/core';
import { PageHeader, Card, Badge, Button } from '@uttily/ui';
import type { BadgeTone } from '@uttily/ui';

const ROLE_LABELS: Record<MembershipRole, string> = {
  OWNER: 'Propriétaire',
  ADMIN: 'Administrateur',
  MANAGER: 'Responsable',
  STAFF: 'Équipe',
};

const ROLE_DESCRIPTIONS: Record<MembershipRole, string> = {
  OWNER: 'Accès complet, gestion de l’organisation, des finances et des rôles.',
  ADMIN: 'Gestion des opérations, de la flotte, des magasins et invitations.',
  MANAGER: 'Gestion des opérations, de la flotte et des magasins.',
  STAFF: 'Gestion des réservations, départs et retours.',
};

function getRoleTone(role: MembershipRole): BadgeTone {
  switch (role) {
    case 'OWNER':
      return 'info';
    case 'ADMIN':
      return 'success';
    case 'MANAGER':
      return 'warning';
    case 'STAFF':
      return 'neutral';
  }
}

const ALL_ROLES: MembershipRole[] = ['ADMIN', 'MANAGER', 'STAFF'];

export function getInvitableRoles(actorRole: MembershipRole): MembershipRole[] {
  return ALL_ROLES.filter((r) => canInviteRole(actorRole, r));
}

export interface TeamMemberViewModel {
  userId: string;
  role: MembershipRole;
  status: MembershipStatus;
  email: string;
}

export interface PendingInvitationViewModel {
  id: string;
  email: string;
  role: MembershipRole;
}

export interface TeamViewProps {
  currentUserId: string;
  currentUserRole: MembershipRole;
  memberRows: TeamMemberViewModel[];
  pendingInvitations: PendingInvitationViewModel[];
  canInvite: boolean;
  canChangeRole: boolean;
  canRemove: boolean;
  invitableRoles: MembershipRole[];
  inviteMember: (formData: FormData) => Promise<void>;
  updateMemberRole: (formData: FormData) => Promise<void>;
  deleteMember: (formData: FormData) => Promise<void>;
  revokeInvitation: (formData: FormData) => Promise<void>;
}

export function TeamView({
  currentUserId,
  currentUserRole,
  memberRows,
  pendingInvitations,
  canInvite,
  canChangeRole,
  canRemove,
  invitableRoles,
  inviteMember,
  updateMemberRole,
  deleteMember,
  revokeInvitation,
}: TeamViewProps): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <PageHeader
        eyebrow="Organisation"
        title="Équipe"
        description="Gérez les collaborateurs de votre organisation et leurs niveaux d’accès."
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: '1.5rem',
          alignItems: 'start',
        }}
      >
        {/* Colonne liste des membres */}
        <Card
          style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}
        >
          <h2
            style={{
              fontSize: '1.15rem',
              fontWeight: 'var(--ut-weight-bold)',
              margin: 0,
              color: 'var(--ut-color-ink-strong)',
            }}
          >
            Membres actifs ({memberRows.length})
          </h2>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {memberRows.map((m) => {
              const isCurrentUser = m.userId === currentUserId;
              const isTargetOwner = m.role === 'OWNER';
              const isTargetAdmin = m.role === 'ADMIN';
              const canRemoveTarget =
                canRemove &&
                !isCurrentUser &&
                (currentUserRole === 'OWNER' || (!isTargetOwner && !isTargetAdmin));

              return (
                <div
                  key={m.userId}
                  style={{
                    background: 'var(--ut-color-surface-soft)',
                    borderRadius: 'var(--ut-radius-md)',
                    padding: '1rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.75rem',
                    border: 'var(--ut-border-thin)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      gap: '0.5rem',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <strong style={{ fontSize: '0.95rem', color: 'var(--ut-color-ink-strong)' }}>
                        {m.email}
                      </strong>
                      {isCurrentUser && <Badge tone="info">Vous</Badge>}
                    </div>
                    <Badge tone={getRoleTone(m.role)}>{ROLE_LABELS[m.role]}</Badge>
                  </div>

                  <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--ut-color-ink-muted)' }}>
                    {ROLE_DESCRIPTIONS[m.role]}
                  </p>

                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'flex-end',
                      gap: '0.5rem',
                      flexWrap: 'wrap',
                      paddingTop: '0.5rem',
                      borderTop: 'var(--ut-border-thin)',
                    }}
                  >
                    {canChangeRole && !isCurrentUser && (
                      <form
                        action={updateMemberRole}
                        style={{ display: 'inline-flex', gap: '0.35rem', alignItems: 'center' }}
                      >
                        <input type="hidden" name="targetUserId" value={m.userId} />
                        <select
                          name="newRole"
                          defaultValue={m.role}
                          aria-label={`Changer le rôle de ${m.email}`}
                          style={{
                            padding: '0.35rem 0.6rem',
                            borderRadius: 'var(--ut-radius-md)',
                            border: 'var(--ut-border-thin)',
                            fontSize: '0.85rem',
                            background: 'var(--ut-color-surface)',
                            color: 'var(--ut-color-ink)',
                          }}
                        >
                          <option value="OWNER">Propriétaire</option>
                          <option value="ADMIN">Administrateur</option>
                          <option value="MANAGER">Responsable</option>
                          <option value="STAFF">Équipe</option>
                        </select>
                        <Button type="submit" variant="secondary" size="sm">
                          Modifier
                        </Button>
                      </form>
                    )}

                    {canRemoveTarget && (
                      <form action={deleteMember} style={{ display: 'inline' }}>
                        <input type="hidden" name="targetUserId" value={m.userId} />
                        <Button type="submit" variant="danger" size="sm">
                          Retirer
                        </Button>
                      </form>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        {/* Colonne latérale : Invitation & Invitations en attente */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {canInvite && invitableRoles.length > 0 && (
            <Card
              style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}
            >
              <h2
                style={{
                  fontSize: '1.15rem',
                  fontWeight: 'var(--ut-weight-bold)',
                  margin: 0,
                  color: 'var(--ut-color-ink-strong)',
                }}
              >
                Inviter un collaborateur
              </h2>
              <form
                action={inviteMember}
                style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}
              >
                <div>
                  <label
                    htmlFor="invite-email"
                    style={{
                      display: 'block',
                      fontSize: '0.85rem',
                      fontWeight: 'var(--ut-weight-semibold)',
                      marginBottom: '0.25rem',
                      color: 'var(--ut-color-ink)',
                    }}
                  >
                    Adresse email
                  </label>
                  <input
                    id="invite-email"
                    type="email"
                    name="email"
                    required
                    placeholder="collaborateur@exemple.com"
                    style={{
                      width: '100%',
                      padding: '0.5rem 0.75rem',
                      borderRadius: 'var(--ut-radius-md)',
                      border: 'var(--ut-border-thin)',
                      fontSize: '0.9rem',
                      background: 'var(--ut-color-surface)',
                      color: 'var(--ut-color-ink)',
                    }}
                  />
                </div>

                <div>
                  <label
                    htmlFor="invite-role"
                    style={{
                      display: 'block',
                      fontSize: '0.85rem',
                      fontWeight: 'var(--ut-weight-semibold)',
                      marginBottom: '0.25rem',
                      color: 'var(--ut-color-ink)',
                    }}
                  >
                    Rôle
                  </label>
                  <select
                    id="invite-role"
                    name="role"
                    defaultValue={invitableRoles[0]}
                    style={{
                      width: '100%',
                      padding: '0.5rem 0.75rem',
                      borderRadius: 'var(--ut-radius-md)',
                      border: 'var(--ut-border-thin)',
                      fontSize: '0.9rem',
                      background: 'var(--ut-color-surface)',
                      color: 'var(--ut-color-ink)',
                    }}
                  >
                    {invitableRoles.map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABELS[role]}
                      </option>
                    ))}
                  </select>
                </div>

                <Button
                  type="submit"
                  variant="primary"
                  style={{ marginTop: '0.5rem', width: '100%' }}
                >
                  Envoyer l’invitation
                </Button>
              </form>
            </Card>
          )}

          <Card
            style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}
          >
            <h2
              style={{
                fontSize: '1.15rem',
                fontWeight: 'var(--ut-weight-bold)',
                margin: 0,
                color: 'var(--ut-color-ink-strong)',
              }}
            >
              Invitations en attente ({pendingInvitations.length})
            </h2>

            {pendingInvitations.length === 0 ? (
              <p style={{ color: 'var(--ut-color-ink-muted)', margin: 0, fontSize: '0.85rem' }}>
                Aucune invitation en attente.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {pendingInvitations.map((inv) => (
                  <div
                    key={inv.id}
                    style={{
                      background: 'var(--ut-color-surface-soft)',
                      padding: '0.85rem',
                      borderRadius: 'var(--ut-radius-md)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '0.5rem',
                      border: 'var(--ut-border-thin)',
                    }}
                  >
                    <div>
                      <strong
                        style={{
                          fontSize: '0.9rem',
                          color: 'var(--ut-color-ink-strong)',
                          display: 'block',
                        }}
                      >
                        {inv.email}
                      </strong>
                      <span style={{ fontSize: '0.8rem', color: 'var(--ut-color-ink-muted)' }}>
                        Rôle : {ROLE_LABELS[inv.role]}
                      </span>
                    </div>

                    {canInvite && (
                      <form action={revokeInvitation} style={{ display: 'inline' }}>
                        <input type="hidden" name="invitationId" value={inv.id} />
                        <Button
                          type="submit"
                          variant="quiet"
                          size="sm"
                          style={{ color: 'var(--ut-color-danger)' }}
                        >
                          Révoquer
                        </Button>
                      </form>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
