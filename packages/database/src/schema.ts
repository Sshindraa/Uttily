import {
  boolean,
  check,
  customType,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Schéma Drizzle — Lot 1 : Identité, organisations et établissements.
 *
 * Conventions (cf. docs/architecture/data-model.md) :
 * - Identifiants UUID v4 générés par PostgreSQL via gen_random_uuid().
 * - organization_id sur toute donnée appartenant à un loueur.
 * - Dates en UTC ; fuseau IANA conservé séparément par établissement.
 * - Suppression logique pour les données métier.
 *
 * Les extensions PostgreSQL (postgis) et les contraintes spécifiques
 * (EXCLUDE) sont écrites explicitement en SQL dans les migrations
 * (cf. ADR-004). Drizzle ne les garantit pas automatiquement.
 *
 * Le type géographique `geometry(Point, 4326)` est représenté par un
 * custom type Drizzle (`geometryPoint`) afin que le schéma TypeScript
 * reste cohérent avec les migrations SQL sans divergence. La création
 * de l'extension PostGIS reste explicite en SQL (migration 0001).
 */

/**
 * Custom type Drizzle pour geometry(Point, 4326) de PostGIS.
 *
 * Le type SQL est déclaré en migration (CREATE TABLE ... geo_point geometry(Point, 4326)).
 * Ce custom type permet à Drizzle de typer la colonne côté TypeScript sans
 * divergence de schéma. La sérialisation/désérialisation WKT est gérée
 * explicitement par l'applicatif lorsqu'il manipule des géométries.
 */
export const geometryPoint = customType<{ data: string | null; default: false }>({
  dataType() {
    return 'geometry(Point, 4326)';
  },
});

export const organizationStatus = pgEnum('organization_status', ['ACTIVE', 'SUSPENDED', 'CLOSED']);

export const membershipRole = pgEnum('membership_role', ['OWNER', 'ADMIN', 'MANAGER', 'STAFF']);

export const membershipStatus = pgEnum('membership_status', ['ACTIVE', 'SUSPENDED', 'REMOVED']);

export const invitationStatus = pgEnum('invitation_status', [
  'PENDING',
  'ACCEPTED',
  'REVOKED',
  'EXPIRED',
]);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    displayName: text('display_name'),
    locale: text('locale').notNull().default('fr'),
    isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
    oidcSubject: text('oidc_subject').unique(),
    oidcProvider: text('oidc_provider'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('users_email_not_empty', sql`length(btrim(${t.email})) > 0`)],
);

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    legalName: text('legal_name').notNull(),
    slug: text('slug').notNull().unique(),
    status: organizationStatus('status').notNull().default('ACTIVE'),
    isProfessional: boolean('is_professional').notNull().default(true),
    defaultCurrency: text('default_currency').notNull().default('EUR'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('organizations_slug_format', sql`${t.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`),
    check('organizations_currency_iso', sql`length(${t.defaultCurrency}) = 3`),
  ],
);

export const organizationMemberships = pgTable(
  'organization_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: membershipRole('role').notNull(),
    status: membershipStatus('status').notNull().default('ACTIVE'),
    invitedBy: uuid('invited_by').references(() => users.id),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Contrainte unique composite : un utilisateur a au plus une membership
    // par organisation. Cohérente avec la migration SQL 0004.
    unique('memberships_organization_user_unique').on(t.organizationId, t.userId),
  ],
);

export const locations = pgTable(
  'locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    timeZone: text('time_zone').notNull(),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    postalCode: text('postal_code'),
    countryCode: text('country_code'),
    // geometry(Point, 4326) via custom type Drizzle (PostGIS).
    geoPoint: geometryPoint('geo_point'),
    pickupEnabled: boolean('pickup_enabled').notNull().default(true),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('locations_slug_format', sql`${t.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`),
    // Slug unique par organisation (pas globalement). Cohérent avec migration 0005.
    unique('locations_organization_slug_unique').on(t.organizationId, t.slug),
  ],
);

export const locationOpeningHours = pgTable(
  'location_opening_hours',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id),
    weekday: smallint('weekday').notNull(),
    openTime: time('open_time').notNull(),
    closeTime: time('close_time').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('opening_hours_weekday_range', sql`${t.weekday} >= 0 AND ${t.weekday} <= 6`),
    check('opening_hours_open_before_close', sql`${t.openTime} < ${t.closeTime}`),
  ],
);

export const organizationInvitations = pgTable(
  'organization_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    email: text('email').notNull(),
    role: membershipRole('role').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    status: invitationStatus('status').notNull().default('PENDING'),
    invitedBy: uuid('invited_by').references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('invitations_email_not_empty', sql`length(btrim(${t.email})) > 0`),
    // Index unique partiel : une seule invitation PENDING par (org, email).
    // Cohérent avec la migration SQL 0009. Les invitations ACCEPTED/REVOKED/EXPIRED
    // peuvent coexister (réinvitation possible après expiration/révocation).
    uniqueIndex('invitations_pending_org_email_unique')
      .on(t.organizationId, t.email)
      .where(sql`${t.status} = 'PENDING'`),
  ],
);

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: uuid('target_id'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Lot 2A — Catalogue et inventaire physique.
// Catégories globales (taxonomie partagée), produits par organisation,
// variantes (au moins une par produit), exemplaires physiques, mouvements.
// ---------------------------------------------------------------------------

export const productPublicationStatus = pgEnum('product_publication_status', [
  'DRAFT',
  'PUBLISHED',
  'ARCHIVED',
]);

export const inventoryCondition = pgEnum('inventory_condition', [
  'NEW',
  'GOOD',
  'FAIR',
  'POOR',
  'BROKEN',
]);

export const inventoryStatus = pgEnum('inventory_status', ['ACTIVE', 'RETIRED', 'LOST']);

// Lot 3 — Disponibilité et blocages (InventoryBlock).
export const inventoryBlockType = pgEnum('inventory_block_type', [
  'HOLD',
  'BOOKING',
  'MAINTENANCE',
  'MANUAL_BLOCK',
]);

export const inventoryBlockStatus = pgEnum('inventory_block_status', [
  'ACTIVE',
  'PAYMENT_PROCESSING',
  'CONVERTED',
  'RELEASED',
  'EXPIRED',
]);

export const categories = pgTable(
  'categories',
  {
    // UUID v4 (convention architecture). Le seed est idempotent par slug.
    id: uuid('id').primaryKey().defaultRandom(),
    // Self-reference : la FK est déclarée en SQL (migration 0010) car
    // Drizzle ne supporte pas la référence circulaire directe dans
    // l'initialiseur de la table.
    parentId: uuid('parent_id'),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('categories_slug_format', sql`${t.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`)],
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description').notNull().default(''),
    publicationStatus: productPublicationStatus('publication_status').notNull().default('DRAFT'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('products_slug_format', sql`${t.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`),
    // Slug unique par organisation (où non supprimé logiquement).
    uniqueIndex('products_organization_slug_active_unique')
      .on(t.organizationId, t.slug)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

export const productVariants = pgTable('product_variants', {
  id: uuid('id').primaryKey().defaultRandom(),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id),
  name: text('name').notNull(),
  skuSuffix: text('sku_suffix'),
  attributes: jsonb('attributes').notNull().default({}),
  isActive: boolean('is_active').notNull().default(true),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const inventoryItems = pgTable(
  'inventory_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    productVariantId: uuid('product_variant_id')
      .notNull()
      .references(() => productVariants.id),
    internalSku: text('internal_sku').notNull(),
    serialNumber: text('serial_number'),
    condition: inventoryCondition('condition').notNull().default('NEW'),
    status: inventoryStatus('status').notNull().default('ACTIVE'),
    currentLocationId: uuid('current_location_id')
      .notNull()
      .references(() => locations.id),
    notes: text('notes'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // internal_sku unique par organisation (où non supprimé).
    uniqueIndex('inventory_items_organization_sku_active_unique')
      .on(t.organizationId, t.internalSku)
      .where(sql`${t.deletedAt} IS NULL`),
    // serial_number unique par organisation (où renseigné et non supprimé).
    uniqueIndex('inventory_items_organization_serial_active_unique')
      .on(t.organizationId, t.serialNumber)
      .where(sql`${t.serialNumber} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ],
);

export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    inventoryItemId: uuid('inventory_item_id')
      .notNull()
      .references(() => inventoryItems.id),
    fromLocationId: uuid('from_location_id').references(() => locations.id),
    toLocationId: uuid('to_location_id').references(() => locations.id),
    reason: text('reason').notNull().default(''),
    createdBy: uuid('created_by').references(() => users.id),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotence : une clé unique par exemplaire.
    uniqueIndex('inventory_movements_item_idempotency_unique')
      .on(t.inventoryItemId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
  ],
);

export const inventoryBlocks = pgTable('inventory_blocks', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  inventoryItemId: uuid('inventory_item_id')
    .notNull()
    .references(() => inventoryItems.id),
  type: inventoryBlockType('type').notNull(),
  status: inventoryBlockStatus('status').notNull().default('ACTIVE'),
  customerStartAt: timestamp('customer_start_at', { withTimezone: true }).notNull(),
  customerEndAt: timestamp('customer_end_at', { withTimezone: true }).notNull(),
  blockedStartAt: timestamp('blocked_start_at', { withTimezone: true }).notNull(),
  blockedEndAt: timestamp('blocked_end_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  sourceId: uuid('source_id'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type OrganizationMembership = typeof organizationMemberships.$inferSelect;
export type NewOrganizationMembership = typeof organizationMemberships.$inferInsert;
export type Location = typeof locations.$inferSelect;
export type NewLocation = typeof locations.$inferInsert;
export type LocationOpeningHour = typeof locationOpeningHours.$inferSelect;
export type NewLocationOpeningHour = typeof locationOpeningHours.$inferInsert;
export type OrganizationInvitation = typeof organizationInvitations.$inferSelect;
export type NewOrganizationInvitation = typeof organizationInvitations.$inferInsert;
export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type ProductVariant = typeof productVariants.$inferSelect;
export type NewProductVariant = typeof productVariants.$inferInsert;
export type InventoryItem = typeof inventoryItems.$inferSelect;
export type NewInventoryItem = typeof inventoryItems.$inferInsert;
export type InventoryMovement = typeof inventoryMovements.$inferSelect;
export type NewInventoryMovement = typeof inventoryMovements.$inferInsert;
export type InventoryBlock = typeof inventoryBlocks.$inferSelect;
export type NewInventoryBlock = typeof inventoryBlocks.$inferInsert;
