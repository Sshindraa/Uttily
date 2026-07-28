import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIntegrationTestDb, type IntegrationTestContext } from './setup';
import { createDatabase } from '@uttily/database';
import {
  createOrganizationForUser,
  listOrganizationsForUser,
  getOrganizationBySlug,
  listLocations,
  createLocation,
  getMembership,
  listMembers,
  changeMemberRole,
  removeMember,
  countActiveOwners,
  createInvitation,
  acceptInvitation,
  provisionUserFromOidc,
  DuplicateInvitationError,
  type AuthenticatedUser,
} from '../index';

const isCi = process.env.CI === '1' || process.env.CI === 'true';

let ctx: IntegrationTestContext | null = null;
let db: ReturnType<typeof createDatabase> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('identity');
  if (ctx) {
    db = createDatabase(ctx.databaseUrl);
  } else if (isCi) {
    // En CI, le setup doit toujours retourner un contexte. Si ce n'est pas
    // le cas, setupIntegrationTestDb a déjà levé une erreur explicite.
    throw new Error("CI: setupIntegrationTestDb a retourné null sans lever d'erreur.");
  }
});

afterAll(async () => {
  // Ferme le pool de connexions Drizzle avant de dropper la base,
  // sinon PostgreSQL refuse le DROP DATABASE (connexions actives).
  if (db) {
    await db.$client.end();
    db = null;
  }
  if (ctx) await ctx.cleanup();
});

beforeEach(async () => {
  if (!ctx || !db) return;
  // Nettoie les tables entre les tests (ordre inverse des dépendances).
  const { sql } = await import('drizzle-orm');
  const {
    auditLog,
    organizationInvitations,
    locationOpeningHours,
    locations,
    organizationMemberships,
    organizations,
    users,
  } = await import('@uttily/database');
  await db.delete(auditLog);
  await db.delete(organizationInvitations);
  await db.delete(locationOpeningHours);
  await db.delete(locations);
  await db.delete(organizationMemberships);
  await db.delete(organizations);
  await db.delete(users);
  void sql;
});

async function createUser(
  db: ReturnType<typeof createDatabase>,
  email: string,
): Promise<AuthenticatedUser> {
  const user = await provisionUserFromOidc(db, {
    oidcSubject: `clerk-${email}`,
    oidcProvider: 'clerk',
    email,
    emailVerified: true,
  });
  return user;
}

// En CI, les tests d'intégration s'exécutent toujours (base PostgreSQL fournie).
// En local, ils sont skippés si DATABASE_URL n'est pas définie ou base injoignable.
describe.skipIf(!isCi && !process.env.DATABASE_URL)('Identity integration — multi-tenant', () => {
  it('crée une organisation et une membership OWNER atomiquement', async () => {
    if (!ctx || !db) return;
    const user = await createUser(db, 'owner-a@example.com');
    const { organization } = await createOrganizationForUser(db, user, {
      legalName: 'Surf Shop A',
      defaultCurrency: 'EUR',
    });
    expect(organization.slug).toBe('surf-shop-a');
    expect(organization.isProfessional).toBe(true);

    const membership = await getMembership(db, organization.id, user.id);
    expect(membership?.role).toBe('OWNER');
    expect(membership?.status).toBe('ACTIVE');
  });

  it('un utilisateur peut appartenir à plusieurs organisations', async () => {
    if (!ctx || !db) return;
    const user = await createUser(db, 'multi@example.com');
    await createOrganizationForUser(db, user, { legalName: 'Org One' });
    await createOrganizationForUser(db, user, { legalName: 'Org Two' });
    const orgs = await listOrganizationsForUser(db, user.id);
    expect(orgs).toHaveLength(2);
  });

  it("isolation multi-tenant : un membre ne voit pas les établissements d'une autre org", async () => {
    if (!ctx || !db) return;
    const userA = await createUser(db, 'a@example.com');
    const userB = await createUser(db, 'b@example.com');
    const { organization: orgA } = await createOrganizationForUser(db, userA, {
      legalName: 'Org A',
    });
    const { organization: orgB } = await createOrganizationForUser(db, userB, {
      legalName: 'Org B',
    });

    await createLocation(db, {
      organizationId: orgA.id,
      name: 'Shop A1',
      timeZone: 'Europe/Paris',
    });
    await createLocation(db, {
      organizationId: orgB.id,
      name: 'Shop B1',
      timeZone: 'Europe/Paris',
    });

    const locationsA = await listLocations(db, orgA.id);
    const locationsB = await listLocations(db, orgB.id);
    expect(locationsA).toHaveLength(1);
    expect(locationsA[0]!.name).toBe('Shop A1');
    expect(locationsB).toHaveLength(1);
    expect(locationsB[0]!.name).toBe('Shop B1');
    expect(locationsA.find((l) => l.name === 'Shop B1')).toBeUndefined();
  });

  it('garde-fou : impossible de rétrograder le dernier OWNER', async () => {
    if (!ctx || !db) return;
    const user = await createUser(db, 'last-owner@example.com');
    const { organization } = await createOrganizationForUser(db, user, {
      legalName: 'Solo Org',
    });
    await expect(changeMemberRole(db, organization.id, user.id, 'ADMIN')).rejects.toThrow();
  });

  it('garde-fou : impossible de retirer le dernier OWNER', async () => {
    if (!ctx || !db) return;
    const user = await createUser(db, 'last-owner2@example.com');
    const { organization } = await createOrganizationForUser(db, user, {
      legalName: 'Solo Org 2',
    });
    await expect(removeMember(db, organization.id, user.id)).rejects.toThrow();
  });

  it('countActiveOwners compte les OWNER actifs', async () => {
    if (!ctx || !db) return;
    const owner = await createUser(db, 'count-owner@example.com');
    const { organization } = await createOrganizationForUser(db, owner, {
      legalName: 'Count Org',
    });
    expect(await countActiveOwners(db, organization.id)).toBe(1);
  });

  it('invitation : crée, accepte et active la membership', async () => {
    if (!ctx || !db) return;
    const owner = await createUser(db, 'inviter@example.com');
    const { organization } = await createOrganizationForUser(db, owner, {
      legalName: 'Invite Org',
    });
    const invitation = await createInvitation(
      db,
      { id: owner.id, role: 'OWNER' },
      {
        organizationId: organization.id,
        email: 'invitee@example.com',
        role: 'STAFF',
        invitedBy: owner.id,
        ttlSeconds: 3600,
      },
    );
    expect(invitation.token).toMatch(/^[0-9a-f]{64}$/);

    // L'invité s'authentifie via Clerk → provisioning.
    const invitee = await provisionUserFromOidc(db, {
      oidcSubject: 'clerk-invitee',
      oidcProvider: 'clerk',
      email: 'invitee@example.com',
      emailVerified: true,
    });

    const result = await acceptInvitation(db, invitee, invitation.token);
    expect(result.organizationId).toBe(organization.id);
    expect(result.role).toBe('STAFF');

    const membership = await getMembership(db, organization.id, invitee.id);
    expect(membership?.role).toBe('STAFF');
    expect(membership?.status).toBe('ACTIVE');
  });

  it("invitation : refuse si l'email ne correspond pas", async () => {
    if (!ctx || !db) return;
    const owner = await createUser(db, 'inviter2@example.com');
    const { organization } = await createOrganizationForUser(db, owner, {
      legalName: 'Invite Org 2',
    });
    const invitation = await createInvitation(
      db,
      { id: owner.id, role: 'OWNER' },
      {
        organizationId: organization.id,
        email: 'right@example.com',
        role: 'STAFF',
        invitedBy: owner.id,
        ttlSeconds: 3600,
      },
    );
    const wrongUser = await provisionUserFromOidc(db, {
      oidcSubject: 'clerk-wrong',
      oidcProvider: 'clerk',
      email: 'wrong@example.com',
      emailVerified: true,
    });
    await expect(acceptInvitation(db, wrongUser, invitation.token)).rejects.toThrow();
  });

  it("slug d'organisation unique", async () => {
    if (!ctx || !db) return;
    const user = await createUser(db, 'slug1@example.com');
    await createOrganizationForUser(db, user, { legalName: 'Duplicate Slug' });
    await expect(
      createOrganizationForUser(db, user, { legalName: 'Duplicate Slug' }),
    ).rejects.toThrow();
  });

  it('slug de location unique par organisation', async () => {
    if (!ctx || !db) return;
    const user = await createUser(db, 'locslug@example.com');
    const { organization } = await createOrganizationForUser(db, user, {
      legalName: 'Loc Slug Org',
    });
    await createLocation(db, {
      organizationId: organization.id,
      name: 'My Shop',
      timeZone: 'Europe/Paris',
    });
    await expect(
      createLocation(db, {
        organizationId: organization.id,
        name: 'My Shop',
        timeZone: 'Europe/Paris',
      }),
    ).rejects.toThrow();
  });

  it('horaires : plusieurs créneaux par jour autorisés', async () => {
    if (!ctx || !db) return;
    const user = await createUser(db, 'hours@example.com');
    const { organization } = await createOrganizationForUser(db, user, {
      legalName: 'Hours Org',
    });
    const loc = await createLocation(db, {
      organizationId: organization.id,
      name: 'Hours Shop',
      timeZone: 'Europe/Paris',
      openingHours: [
        { weekday: 0, openTime: '09:00:00', closeTime: '12:00:00' },
        { weekday: 0, openTime: '14:00:00', closeTime: '18:00:00' },
      ],
    });
    expect(loc.id).toBeDefined();
  });

  it('horaires : open_time >= close_time rejeté par la base', async () => {
    if (!ctx || !db) return;
    const user = await createUser(db, 'hours2@example.com');
    const { organization } = await createOrganizationForUser(db, user, {
      legalName: 'Hours Org 2',
    });
    await expect(
      createLocation(db, {
        organizationId: organization.id,
        name: 'Bad Hours',
        timeZone: 'Europe/Paris',
        openingHours: [{ weekday: 1, openTime: '18:00:00', closeTime: '09:00:00' }],
      }),
    ).rejects.toThrow();
  });

  it('provisioning : réutilise un utilisateur existant par oidc_subject', async () => {
    if (!ctx || !db) return;
    const first = await provisionUserFromOidc(db, {
      oidcSubject: 'clerk-reuse',
      oidcProvider: 'clerk',
      email: 'reuse@example.com',
      emailVerified: true,
    });
    const second = await provisionUserFromOidc(db, {
      oidcSubject: 'clerk-reuse',
      oidcProvider: 'clerk',
      email: 'reuse@example.com',
      emailVerified: true,
    });
    expect(second.id).toBe(first.id);
  });

  it('provisioning : relie un utilisateur existant par email', async () => {
    if (!ctx || !db) return;
    const first = await provisionUserFromOidc(db, {
      oidcSubject: 'clerk-a',
      oidcProvider: 'clerk',
      email: 'link@example.com',
      emailVerified: true,
    });
    // Même email, oidc_subject différent (changement de provider par ex.)
    const second = await provisionUserFromOidc(db, {
      oidcSubject: 'clerk-b',
      oidcProvider: 'clerk',
      email: 'link@example.com',
      emailVerified: true,
    });
    expect(second.id).toBe(first.id);
    expect(second.oidcSubject).toBe('clerk-b');
  });

  it('getOrganizationBySlug récupère une organisation par slug', async () => {
    if (!ctx || !db) return;
    const user = await createUser(db, 'find@example.com');
    await createOrganizationForUser(db, user, { legalName: 'Find Me' });
    const org = await getOrganizationBySlug(db, 'find-me');
    expect(org?.legalName).toBe('Find Me');
  });

  it('listMembers retourne les membres actifs', async () => {
    if (!ctx || !db) return;
    const owner = await createUser(db, 'listmembers@example.com');
    const { organization } = await createOrganizationForUser(db, owner, {
      legalName: 'Members Org',
    });
    const members = await listMembers(db, organization.id);
    expect(members).toHaveLength(1);
    expect(members[0]!.role).toBe('OWNER');
  });

  it('invitation : pas de doublon PENDING via contrainte SQL (concurrence)', async () => {
    if (!ctx || !db) return;
    const owner = await createUser(db, 'conc-invite@example.com');
    const { organization } = await createOrganizationForUser(db, owner, {
      legalName: 'Concurrent Invite Org',
    });
    // Deux créations concurrentes de la même invitation.
    const results = await Promise.allSettled([
      createInvitation(
        db,
        { id: owner.id, role: 'OWNER' },
        {
          organizationId: organization.id,
          email: 'dup@example.com',
          role: 'STAFF',
          invitedBy: owner.id,
          ttlSeconds: 3600,
        },
      ),
      createInvitation(
        db,
        { id: owner.id, role: 'OWNER' },
        {
          organizationId: organization.id,
          email: 'dup@example.com',
          role: 'STAFF',
          invitedBy: owner.id,
          ttlSeconds: 3600,
        },
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0]!.status === 'rejected') {
      expect(rejected[0]!.reason).toBeInstanceOf(DuplicateInvitationError);
    }
  });

  it('concurrence changeMemberRole : deux OWNER rétrogradés simultanément, au moins un reste OWNER', async () => {
    if (!ctx || !db) return;
    // Organisation avec deux OWNER.
    const owner1 = await createUser(db, 'conc-owner1@example.com');
    const owner2 = await createUser(db, 'conc-owner2@example.com');
    const { organization } = await createOrganizationForUser(db, owner1, {
      legalName: 'Concurrent Owners Org',
    });
    // Ajoute owner2 comme OWNER via une membership directe.
    const { organizationMemberships } = await import('@uttily/database');
    await db.insert(organizationMemberships).values({
      organizationId: organization.id,
      userId: owner2.id,
      role: 'OWNER',
      status: 'ACTIVE',
      acceptedAt: new Date(),
    });
    expect(await countActiveOwners(db, organization.id)).toBe(2);

    // Tente de rétrograder les deux OWNER simultanément.
    const results = await Promise.allSettled([
      changeMemberRole(db, organization.id, owner1.id, 'ADMIN'),
      changeMemberRole(db, organization.id, owner2.id, 'ADMIN'),
    ]);
    // Exactement une opération doit réussir, l'autre doit échouer.
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Invariant : au moins un OWNER actif reste.
    const owners = await countActiveOwners(db, organization.id);
    expect(owners).toBeGreaterThanOrEqual(1);
  });

  it('concurrence removeMember : deux OWNER retirés simultanément, au moins un reste OWNER', async () => {
    if (!ctx || !db) return;
    const owner1 = await createUser(db, 'conc-rm-owner1@example.com');
    const owner2 = await createUser(db, 'conc-rm-owner2@example.com');
    const { organization } = await createOrganizationForUser(db, owner1, {
      legalName: 'Concurrent Remove Org',
    });
    const { organizationMemberships } = await import('@uttily/database');
    await db.insert(organizationMemberships).values({
      organizationId: organization.id,
      userId: owner2.id,
      role: 'OWNER',
      status: 'ACTIVE',
      acceptedAt: new Date(),
    });
    expect(await countActiveOwners(db, organization.id)).toBe(2);

    const results = await Promise.allSettled([
      removeMember(db, organization.id, owner1.id),
      removeMember(db, organization.id, owner2.id),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Invariant : au moins un OWNER actif reste.
    const owners = await countActiveOwners(db, organization.id);
    expect(owners).toBeGreaterThanOrEqual(1);
  });
});
