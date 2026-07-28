import { describe, it, expect } from 'vitest';
import {
  CATALOG_MANAGERS,
  CATALOG_VIEWERS,
  requireCatalogManager,
  requireCatalogViewer,
  requireCategoryManager,
  AuthorizationError,
  type MembershipRecord,
  type AuthenticatedUser,
} from '../index';

function makeMembership(
  role: MembershipRecord['role'],
  status: MembershipRecord['status'] = 'ACTIVE',
): MembershipRecord {
  return { organizationId: 'org-1', userId: 'user-1', role, status };
}

function makeUser(isAdmin = false): AuthenticatedUser {
  return {
    id: 'user-1',
    oidcSubject: 'clerk-1',
    email: 'test@example.com',
    emailVerified: true,
    isPlatformAdmin: isAdmin,
  };
}

describe('catalog permissions', () => {
  it('CATALOG_MANAGERS contient OWNER, ADMIN, MANAGER (pas STAFF)', () => {
    expect(CATALOG_MANAGERS).toEqual(['OWNER', 'ADMIN', 'MANAGER']);
  });

  it('CATALOG_VIEWERS contient OWNER, ADMIN, MANAGER, STAFF', () => {
    expect(CATALOG_VIEWERS).toEqual(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']);
  });

  it('requireCatalogManager accepte OWNER, ADMIN, MANAGER', () => {
    for (const role of ['OWNER', 'ADMIN', 'MANAGER'] as const) {
      expect(() => requireCatalogManager(makeMembership(role))).not.toThrow();
    }
  });

  it('requireCatalogManager refuse STAFF', () => {
    expect(() => requireCatalogManager(makeMembership('STAFF'))).toThrow(AuthorizationError);
  });

  it('requireCatalogManager refuse null', () => {
    expect(() => requireCatalogManager(null)).toThrow(AuthorizationError);
  });

  it('requireCatalogManager refuse membership non active', () => {
    expect(() => requireCatalogManager(makeMembership('OWNER', 'SUSPENDED'))).toThrow(
      AuthorizationError,
    );
  });

  it('requireCatalogViewer accepte STAFF', () => {
    expect(() => requireCatalogViewer(makeMembership('STAFF'))).not.toThrow();
  });

  it('requireCatalogViewer refuse null', () => {
    expect(() => requireCatalogViewer(null)).toThrow(AuthorizationError);
  });

  it('requireCategoryManager accepte admin Uttily', () => {
    expect(() => requireCategoryManager(makeUser(true))).not.toThrow();
  });

  it('requireCategoryManager refuse un utilisateur non admin', () => {
    expect(() => requireCategoryManager(makeUser(false))).toThrow(AuthorizationError);
  });
});
