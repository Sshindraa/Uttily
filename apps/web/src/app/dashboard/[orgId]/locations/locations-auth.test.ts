import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireMembership, LOCATION_MANAGERS, type MembershipRecord } from '@uttily/core';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(__dirname, '../../../../features/locations/locations-list-view.tsx');

describe('LocationsListPage — Authorization and RBAC Guardrails (Chantier 21-U2.1)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');
  const source = `${pageSource}\n${featureSource}`;

  it('1. Présente les auth gates stricts dans le code source de la page', () => {
    expect(pageSource).toContain('getAuthenticatedUser()');
    expect(pageSource).toContain("redirect('/sign-in')");
    expect(pageSource).toContain('getMembership(db, orgId, user.id)');
    expect(pageSource).toContain(
      "requireMembership(membership, ['OWNER', 'ADMIN', 'MANAGER', 'STAFF'])",
    );
    expect(pageSource).toContain('LOCATION_MANAGERS.includes(active.role)');
    expect(pageSource).not.toContain('try {');
  });

  it('2. Refuse l’accès aux utilisateurs hors organisation ou avec membership non active', () => {
    expect(() => {
      requireMembership(null, ['OWNER', 'ADMIN', 'MANAGER', 'STAFF']);
    }).toThrow(/Aucune appartenance/);

    const suspendedMembership: MembershipRecord = {
      organizationId: 'org-1',
      userId: 'user-1',
      role: 'STAFF',
      status: 'SUSPENDED',
    };
    expect(() => {
      requireMembership(suspendedMembership, ['OWNER', 'ADMIN', 'MANAGER', 'STAFF']);
    }).toThrow(/Appartenance non active/);
  });

  it('3. Autorise les membres en consultation (STAFF) mais leur refuse les actions de gestion', () => {
    const staffMembership: MembershipRecord = {
      organizationId: 'org-1',
      userId: 'user-staff',
      role: 'STAFF',
      status: 'ACTIVE',
    };
    const active = requireMembership(staffMembership, ['OWNER', 'ADMIN', 'MANAGER', 'STAFF']);
    expect(active.role).toBe('STAFF');

    const canManage = LOCATION_MANAGERS.includes(active.role);
    expect(canManage).toBe(false);
  });

  it('4. Autorise les managers (OWNER, ADMIN, MANAGER) et leur accorde les actions de gestion', () => {
    const roles: ('OWNER' | 'ADMIN' | 'MANAGER')[] = ['OWNER', 'ADMIN', 'MANAGER'];
    for (const role of roles) {
      const managerMembership: MembershipRecord = {
        organizationId: 'org-1',
        userId: `user-${role.toLowerCase()}`,
        role,
        status: 'ACTIVE',
      };
      const active = requireMembership(managerMembership, ['OWNER', 'ADMIN', 'MANAGER', 'STAFF']);
      expect(LOCATION_MANAGERS.includes(active.role)).toBe(true);
    }
  });

  it('laisse la présentation de la liste à la feature locations', () => {
    expect(pageSource).toContain('<LocationsListView');
    expect(pageSource).not.toContain('<PageHeader');
    expect(source).toContain('Établissements');
  });
});
