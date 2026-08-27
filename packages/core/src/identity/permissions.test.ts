import { describe, it, expect } from 'vitest';
import {
  AuthorizationError,
  requireMembership,
  requireCapability,
  can,
  hasMinimumRole,
  canInviteRole,
  requirePlatformAdmin,
  LOCATION_MANAGERS,
  MEMBER_INVITERS,
  ROLE_MANAGERS,
} from './permissions';
import type { MembershipRecord, MembershipRole, AuthenticatedUser } from './types';

function membership(
  role: MembershipRole,
  status: MembershipRecord['status'] = 'ACTIVE',
): MembershipRecord {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    role,
    status,
  };
}

function user(isAdmin = false): AuthenticatedUser {
  return {
    id: 'user-1',
    oidcSubject: 'clerk-1',
    email: 'a@b.com',
    emailVerified: true,
    isPlatformAdmin: isAdmin,
  };
}

describe('permissions', () => {
  describe('requireMembership', () => {
    it('accepte un membre actif avec un rôle autorisé', () => {
      const m = membership('OWNER');
      expect(requireMembership(m, ['OWNER', 'ADMIN'])).toBe(m);
    });

    it('rejette si pas de membership', () => {
      expect(() => requireMembership(null, ['OWNER'])).toThrow(AuthorizationError);
    });

    it('rejette si membership non active', () => {
      expect(() => requireMembership(membership('OWNER', 'SUSPENDED'), ['OWNER'])).toThrow(
        AuthorizationError,
      );
      expect(() => requireMembership(membership('OWNER', 'REMOVED'), ['OWNER'])).toThrow(
        AuthorizationError,
      );
    });

    it('rejette si rôle insuffisant', () => {
      expect(() => requireMembership(membership('STAFF'), ['OWNER', 'ADMIN'])).toThrow(
        AuthorizationError,
      );
    });
  });

  describe('can (Capability Matrix)', () => {
    it('OWNER possède toutes les capacités', () => {
      expect(can('OWNER', 'bookings.manage')).toBe(true);
      expect(can('OWNER', 'fleet.manage')).toBe(true);
      expect(can('OWNER', 'locations.manage')).toBe(true);
      expect(can('OWNER', 'finances.view')).toBe(true);
      expect(can('OWNER', 'payouts.manage')).toBe(true);
      expect(can('OWNER', 'team.invite')).toBe(true);
      expect(can('OWNER', 'team.remove')).toBe(true);
      expect(can('OWNER', 'team.changeRole')).toBe(true);
      expect(can('OWNER', 'organization.manage')).toBe(true);
      expect(can('OWNER', 'policy.manage')).toBe(true);
    });

    it('ADMIN possède les capacités administratives mais ne peut pas changer les rôles', () => {
      expect(can('ADMIN', 'bookings.manage')).toBe(true);
      expect(can('ADMIN', 'fleet.manage')).toBe(true);
      expect(can('ADMIN', 'locations.manage')).toBe(true);
      expect(can('ADMIN', 'finances.view')).toBe(true);
      expect(can('ADMIN', 'payouts.manage')).toBe(true);
      expect(can('ADMIN', 'team.invite')).toBe(true);
      expect(can('ADMIN', 'team.remove')).toBe(true);
      expect(can('ADMIN', 'team.changeRole')).toBe(false); // Réservé à OWNER
      expect(can('ADMIN', 'organization.manage')).toBe(true);
      expect(can('ADMIN', 'policy.manage')).toBe(true);
    });

    it('MANAGER gère opérations, flotte et magasins, mais pas les finances/équipe/paramètres', () => {
      expect(can('MANAGER', 'bookings.manage')).toBe(true);
      expect(can('MANAGER', 'fulfillment.manage')).toBe(true);
      expect(can('MANAGER', 'fleet.manage')).toBe(true);
      expect(can('MANAGER', 'locations.manage')).toBe(true);
      expect(can('MANAGER', 'finances.view')).toBe(false);
      expect(can('MANAGER', 'payouts.manage')).toBe(false);
      expect(can('MANAGER', 'team.invite')).toBe(false);
      expect(can('MANAGER', 'team.remove')).toBe(false);
      expect(can('MANAGER', 'team.changeRole')).toBe(false);
      expect(can('MANAGER', 'organization.manage')).toBe(false);
      expect(can('MANAGER', 'policy.manage')).toBe(false);
    });

    it('STAFF gère uniquement réservations, départs/retours et flotte', () => {
      expect(can('STAFF', 'bookings.manage')).toBe(true);
      expect(can('STAFF', 'fulfillment.manage')).toBe(true);
      expect(can('STAFF', 'fleet.manage')).toBe(true);
      expect(can('STAFF', 'locations.manage')).toBe(false);
      expect(can('STAFF', 'finances.view')).toBe(false);
      expect(can('STAFF', 'team.invite')).toBe(false);
      expect(can('STAFF', 'organization.manage')).toBe(false);
    });
  });

  describe('requireCapability', () => {
    it('accepte si le membre a la capacité', () => {
      const m = membership('ADMIN');
      expect(requireCapability(m, 'locations.manage')).toBe(m);
    });

    it('rejette avec AuthorizationError si la capacité est manquante', () => {
      const m = membership('STAFF');
      expect(() => requireCapability(m, 'locations.manage')).toThrow(AuthorizationError);
    });
  });

  describe('hasMinimumRole', () => {
    it('compare les rangs', () => {
      expect(hasMinimumRole('OWNER', 'ADMIN')).toBe(true);
      expect(hasMinimumRole('ADMIN', 'OWNER')).toBe(false);
      expect(hasMinimumRole('STAFF', 'STAFF')).toBe(true);
    });
  });

  describe('canInviteRole', () => {
    it('OWNER peut inviter ADMIN, MANAGER, STAFF mais pas OWNER', () => {
      expect(canInviteRole('OWNER', 'ADMIN')).toBe(true);
      expect(canInviteRole('OWNER', 'MANAGER')).toBe(true);
      expect(canInviteRole('OWNER', 'STAFF')).toBe(true);
      expect(canInviteRole('OWNER', 'OWNER')).toBe(false);
    });

    it('ADMIN peut inviter MANAGER et STAFF mais pas OWNER ni ADMIN', () => {
      expect(canInviteRole('ADMIN', 'MANAGER')).toBe(true);
      expect(canInviteRole('ADMIN', 'STAFF')).toBe(true);
      expect(canInviteRole('ADMIN', 'ADMIN')).toBe(false);
      expect(canInviteRole('ADMIN', 'OWNER')).toBe(false);
    });

    it('MANAGER et STAFF ne peuvent pas inviter', () => {
      expect(canInviteRole('MANAGER', 'STAFF')).toBe(false);
      expect(canInviteRole('STAFF', 'STAFF')).toBe(false);
    });
  });

  describe('requirePlatformAdmin', () => {
    it('accepte un admin Uttily', () => {
      expect(() => requirePlatformAdmin(user(true))).not.toThrow();
    });
    it('rejette un utilisateur standard', () => {
      expect(() => requirePlatformAdmin(user(false))).toThrow(AuthorizationError);
    });
  });

  describe('constantes de rôles', () => {
    it('LOCATION_MANAGERS inclut OWNER, ADMIN, MANAGER', () => {
      expect(LOCATION_MANAGERS).toContain('OWNER');
      expect(LOCATION_MANAGERS).toContain('ADMIN');
      expect(LOCATION_MANAGERS).toContain('MANAGER');
      expect(LOCATION_MANAGERS).not.toContain('STAFF');
    });

    it('MEMBER_INVITERS inclut OWNER et ADMIN', () => {
      expect(MEMBER_INVITERS).toContain('OWNER');
      expect(MEMBER_INVITERS).toContain('ADMIN');
      expect(MEMBER_INVITERS).not.toContain('MANAGER');
    });

    it('ROLE_MANAGERS contient uniquement OWNER', () => {
      expect(ROLE_MANAGERS).toEqual(['OWNER']);
    });
  });
});
