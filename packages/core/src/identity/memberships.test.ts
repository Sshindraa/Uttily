import { describe, it, expect } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import { changeMemberRole, removeMember } from './memberships';
import { AuthorizationError } from './permissions';

describe('memberships mutations auth & actor guards', () => {
  const fakeDb = {} as unknown as DatabaseClient;

  describe('changeMemberRole', () => {
    it('refuse si l’acteur est ADMIN (seul OWNER peut changer les rôles)', async () => {
      await expect(
        changeMemberRole(fakeDb, 'org-1', 'target-user', 'MANAGER', {
          userId: 'admin-user',
          role: 'ADMIN',
        }),
      ).rejects.toThrow(AuthorizationError);
    });

    it('refuse si l’acteur est MANAGER ou STAFF', async () => {
      await expect(
        changeMemberRole(fakeDb, 'org-1', 'target-user', 'STAFF', {
          userId: 'manager-user',
          role: 'MANAGER',
        }),
      ).rejects.toThrow(AuthorizationError);

      await expect(
        changeMemberRole(fakeDb, 'org-1', 'target-user', 'MANAGER', {
          userId: 'staff-user',
          role: 'STAFF',
        }),
      ).rejects.toThrow(AuthorizationError);
    });
  });

  describe('removeMember', () => {
    it('refuse si l’acteur est MANAGER ou STAFF (pas de capacité team.remove)', async () => {
      await expect(
        removeMember(fakeDb, 'org-1', 'target-user', {
          userId: 'manager-user',
          role: 'MANAGER',
        }),
      ).rejects.toThrow(AuthorizationError);

      await expect(
        removeMember(fakeDb, 'org-1', 'target-user', {
          userId: 'staff-user',
          role: 'STAFF',
        }),
      ).rejects.toThrow(AuthorizationError);
    });
  });
});
