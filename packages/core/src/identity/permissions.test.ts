import { describe, it, expect } from 'vitest';
import {
  AuthorizationError,
  requireMembership,
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
