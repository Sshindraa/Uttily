import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { createDatabase, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import {
  createProduct,
  updateProduct,
  publishProduct,
  archiveProduct,
  createVariant,
  createInventoryItem,
  transferInventoryItem,
  updateLocation,
  createInvitation,
  changeMemberRole,
  removeMember,
  openMaintenanceCase,
  requireCapability,
  getMembership,
  AuthorizationError,
  DEFAULT_INVITATION_TTL_SECONDS,
} from '../index';

let context: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

let orgAId: string;
let orgBId: string;
let userAId: string;
let userBId: string;
let userCId: string;
let categoryId: string;
let locationAId: string;
let locationBId: string;
let productAId: string;
let variantAId: string;
let itemAId: string;
let productBId: string;
let variantBId: string;
let itemBId: string;
let seedCount = 0;

beforeAll(async () => {
  if (shouldSkipIntegrationTests()) return;
  context = await setupIntegrationTestDb('tenant_isolation');
  if (context) {
    db = createDatabase(context.databaseUrl);
    rawSql = postgres(context.databaseUrl, { max: 5 });
  }
});

afterAll(async () => {
  if (db) await db.$client.end();
  if (rawSql) await rawSql.end();
  if (context) await context.cleanup();
});

beforeEach(async () => {
  if (!db || !rawSql) return;

  seedCount++;
  const suffix = `${seedCount}-${Date.now().toString(36)}`;

  await db.execute(
    sql`TRUNCATE TABLE
      maintenance_cases,
      inventory_movements,
      inventory_items,
      product_variants,
      product_photos,
      products,
      categories,
      location_schedule_exceptions,
      location_opening_hours,
      locations,
      organization_invitations,
      organization_memberships,
      organizations,
      users
      RESTART IDENTITY CASCADE`,
  );

  const orgARow = await rawSql`
    INSERT INTO organizations (legal_name, slug, is_professional, default_currency)
    VALUES ('Org A', ${`org-a-${suffix}`}, true, 'EUR')
    RETURNING id
  `.then((r) => r[0]!);
  orgAId = orgARow.id;

  const orgBRow = await rawSql`
    INSERT INTO organizations (legal_name, slug, is_professional, default_currency)
    VALUES ('Org B', ${`org-b-${suffix}`}, true, 'EUR')
    RETURNING id
  `.then((r) => r[0]!);
  orgBId = orgBRow.id;

  const userARow = await rawSql`
    INSERT INTO users (email)
    VALUES (${`usera-${suffix}@example.invalid`})
    RETURNING id
  `.then((r) => r[0]!);
  userAId = userARow.id;

  const userBRow = await rawSql`
    INSERT INTO users (email)
    VALUES (${`userb-${suffix}@example.invalid`})
    RETURNING id
  `.then((r) => r[0]!);
  userBId = userBRow.id;

  const userCRow = await rawSql`
    INSERT INTO users (email)
    VALUES (${`userc-${suffix}@example.invalid`})
    RETURNING id
  `.then((r) => r[0]!);
  userCId = userCRow.id;

  // Memberships: User A is OWNER of Org A, User B is OWNER of Org B, User C has no membership
  await rawSql`
    INSERT INTO organization_memberships (organization_id, user_id, role, status)
    VALUES
      (${orgAId}, ${userAId}, 'OWNER', 'ACTIVE'),
      (${orgBId}, ${userBId}, 'OWNER', 'ACTIVE')
  `;

  const catRow = await rawSql`
    INSERT INTO categories (name, slug)
    VALUES ('Vélos', ${`cat-${suffix}`})
    RETURNING id
  `.then((r) => r[0]!);
  categoryId = catRow.id;

  const locARow = await rawSql`
    INSERT INTO locations (organization_id, name, slug, time_zone, operating_currency)
    VALUES (${orgAId}, 'Location A', ${`loc-a-${suffix}`}, 'Europe/Paris', 'EUR')
    RETURNING id
  `.then((r) => r[0]!);
  locationAId = locARow.id;

  const locBRow = await rawSql`
    INSERT INTO locations (organization_id, name, slug, time_zone, operating_currency)
    VALUES (${orgBId}, 'Location B', ${`loc-b-${suffix}`}, 'Europe/Paris', 'EUR')
    RETURNING id
  `.then((r) => r[0]!);
  locationBId = locBRow.id;

  const prodA = await createProduct(db, {
    organizationId: orgAId,
    categoryId,
    name: 'VTT Org A',
  });
  productAId = prodA.id;

  const varA = await createVariant(db, {
    organizationId: orgAId,
    productId: productAId,
    name: 'Taille M',
  });
  variantAId = varA.id;

  const itemA = await createInventoryItem(db, {
    organizationId: orgAId,
    productVariantId: variantAId,
    currentLocationId: locationAId,
    internalSku: `SKU-A-${suffix}`,
    status: 'ACTIVE',
  });
  itemAId = itemA.id;

  const prodB = await createProduct(db, {
    organizationId: orgBId,
    categoryId,
    name: 'VTT Org B',
  });
  productBId = prodB.id;

  const varB = await createVariant(db, {
    organizationId: orgBId,
    productId: productBId,
    name: 'Taille L',
  });
  variantBId = varB.id;

  const itemB = await createInventoryItem(db, {
    organizationId: orgBId,
    productVariantId: variantBId,
    currentLocationId: locationBId,
    internalSku: `SKU-B-${suffix}`,
    status: 'ACTIVE',
  });
  itemBId = itemB.id;
});

describe.skipIf(shouldSkipIntegrationTests())(
  '19-A — Tenant Boundaries & Security Integration',
  () => {
    describe('Isolation du Catalogue & Inventaire', () => {
      it('interdit la modification ou l’archivage d’un produit de l’Org B par l’Org A', async () => {
        // Tentative d'update du produit de l'Org B avec le tenant orgAId
        await expect(
          updateProduct(db!, orgAId, productBId, { name: 'Piratage Nom' }),
        ).rejects.toThrow(AuthorizationError);

        // Tentative d'archivage du produit de l'Org B avec le tenant orgAId
        await expect(archiveProduct(db!, orgAId, productBId)).rejects.toThrow(AuthorizationError);

        // Tentative de publication du produit de l'Org B avec le tenant orgAId
        await expect(publishProduct(db!, orgAId, productBId)).rejects.toThrow(AuthorizationError);
      });

      it('rejette en base (trigger PostgreSQL) la création d’un exemplaire rattaché à une variante d’une autre organisation', async () => {
        await expect(
          createInventoryItem(db!, {
            organizationId: orgAId,
            productVariantId: variantBId, // Variante de l'Org B !
            currentLocationId: locationAId,
            internalSku: `CROSS-ORG-1-${Date.now()}`,
            status: 'ACTIVE',
          }),
        ).rejects.toThrow();
      });

      it('rejette en base (trigger PostgreSQL) la création d’un exemplaire rattaché à un établissement d’une autre organisation', async () => {
        await expect(
          createInventoryItem(db!, {
            organizationId: orgAId,
            productVariantId: variantAId,
            currentLocationId: locationBId, // Établissement de l'Org B !
            internalSku: `CROSS-ORG-2-${Date.now()}`,
            status: 'ACTIVE',
          }),
        ).rejects.toThrow();
      });

      it('interdit le transfert d’un exemplaire de l’Org A vers un établissement de l’Org B', async () => {
        await expect(
          transferInventoryItem(db!, {
            organizationId: orgAId,
            inventoryItemId: itemAId,
            toLocationId: locationBId, // Location de l'Org B
            idempotencyKey: crypto.randomUUID(),
            createdBy: userAId,
          }),
        ).rejects.toThrow();
      });

      it('interdit l’ouverture d’un dossier de maintenance sur un exemplaire de l’Org B depuis l’Org A', async () => {
        await expect(
          openMaintenanceCase(db!, {
            organizationId: orgAId,
            inventoryItemId: itemBId, // Item de l'Org B
            actorUserId: userAId,
            reason: 'Maintenance pirate',
            idempotencyKey: crypto.randomUUID(),
          }),
        ).rejects.toThrow();
      });
    });

    describe('Isolation de l’Équipe, Membres & Invitations', () => {
      it('interdit à un utilisateur de l’Org A de modifier ou inviter dans l’Org B', async () => {
        const membershipAOnB = await getMembership(db!, orgBId, userAId);
        expect(membershipAOnB).toBeNull();

        expect(() => requireCapability(membershipAOnB, 'team.invite')).toThrow(AuthorizationError);

        await expect(
          createInvitation(
            db!,
            { id: userAId, role: 'OWNER' },
            {
              organizationId: orgBId,
              email: 'spy@example.invalid',
              role: 'MANAGER',
              invitedBy: userAId,
              ttlSeconds: DEFAULT_INVITATION_TTL_SECONDS,
            },
          ),
        ).rejects.toThrow();
      });

      it('interdit de changer le rôle ou retirer un membre d’une autre organisation', async () => {
        await expect(
          changeMemberRole(db!, orgAId, userBId, 'MANAGER', {
            userId: userAId,
            role: 'OWNER',
          }),
        ).rejects.toThrow();

        await expect(
          removeMember(db!, orgAId, userBId, {
            userId: userAId,
            role: 'OWNER',
          }),
        ).rejects.toThrow();
      });
    });

    describe('Isolation des Établissements & Guardrails', () => {
      it('interdit la mise à jour d’un établissement de l’Org B avec le contexte Org A', async () => {
        await expect(
          updateLocation(db!, orgAId, locationBId, { name: 'Nouveau nom piraté' }),
        ).rejects.toThrow();
      });

      it('bloque un utilisateur sans organisation (User C) sur les actions nécessitant des capacités pro', async () => {
        const memC = await getMembership(db!, orgAId, userCId);
        expect(memC).toBeNull();

        expect(() => requireCapability(memC, 'fleet.manage')).toThrow(AuthorizationError);
        expect(() => requireCapability(memC, 'locations.manage')).toThrow(AuthorizationError);
        expect(() => requireCapability(memC, 'team.invite')).toThrow(AuthorizationError);
        expect(() => requireCapability(memC, 'organization.manage')).toThrow(AuthorizationError);
      });
    });
  },
);
