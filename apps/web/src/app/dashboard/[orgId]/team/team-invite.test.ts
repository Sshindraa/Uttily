import { describe, it, expect } from 'vitest';
import { getInvitableRoles } from '@/features/team';

describe('Team Invitation Role Matrix (Chantier 21-U2.3)', () => {
  it('OWNER peut inviter ADMIN, MANAGER et STAFF, mais jamais OWNER', () => {
    const roles = getInvitableRoles('OWNER');
    expect(roles).toEqual(['ADMIN', 'MANAGER', 'STAFF']);
    expect(roles).not.toContain('OWNER');
  });

  it('ADMIN peut inviter uniquement MANAGER et STAFF (ni OWNER ni ADMIN)', () => {
    const roles = getInvitableRoles('ADMIN');
    expect(roles).toEqual(['MANAGER', 'STAFF']);
    expect(roles).not.toContain('OWNER');
    expect(roles).not.toContain('ADMIN');
  });

  it('MANAGER et STAFF ne peuvent inviter aucun rôle', () => {
    expect(getInvitableRoles('MANAGER')).toEqual([]);
    expect(getInvitableRoles('STAFF')).toEqual([]);
  });
});
