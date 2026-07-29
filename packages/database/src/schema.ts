import {
  bigint,
  boolean,
  check,
  customType,
  integer,
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

export const cancellationPolicyCode = pgEnum('cancellation_policy_code', [
  'FLEXIBLE',
  'MODERATE',
  'FIRM',
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
    defaultCancellationPolicyCode: cancellationPolicyCode('default_cancellation_policy_code')
      .notNull()
      .default('FLEXIBLE'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('organizations_slug_format', sql`${t.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`),
    check('organizations_currency_iso', sql`length(${t.defaultCurrency}) = 3`),
    check(
      'organizations_default_cancellation_policy_code_valid',
      sql`${t.defaultCancellationPolicyCode} IN ('FLEXIBLE', 'MODERATE', 'FIRM')`,
    ),
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
    prepBufferMinutes: integer('prep_buffer_minutes').notNull().default(30),
    cleanupBufferMinutes: integer('cleanup_buffer_minutes').notNull().default(30),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('locations_slug_format', sql`${t.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`),
    // Slug unique par organisation (pas globalement). Cohérent avec migration 0005.
    unique('locations_organization_slug_unique').on(t.organizationId, t.slug),
    check('locations_prep_buffer_nonneg', sql`${t.prepBufferMinutes} >= 0`),
    check('locations_cleanup_buffer_nonneg', sql`${t.cleanupBufferMinutes} >= 0`),
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

// Lot 4 — Prix, brouillon de réservation, allocations et idempotence (ADR-009).
export const bookingDraftStatus = pgEnum('booking_draft_status', [
  'DRAFT',
  'HELD',
  'PAYMENT_PROCESSING',
  'EXPIRED',
  'CANCELLED',
  'CONVERTED',
]);

export const taxStatus = pgEnum('tax_status', ['UNDETERMINED', 'NOT_APPLICABLE', 'APPLIED']);

export const allocationStatus = pgEnum('allocation_status', ['ALLOCATED', 'RELEASED', 'CONVERTED']);

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

export const productVariants = pgTable(
  'product_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    name: text('name').notNull(),
    skuSuffix: text('sku_suffix'),
    attributes: jsonb('attributes').notNull().default({}),
    isActive: boolean('is_active').notNull().default(true),
    dailyPriceAmountMinor: bigint('daily_price_amount_minor', { mode: 'number' }),
    currency: text('currency').notNull().default('EUR'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'product_variants_daily_price_positive',
      sql`${t.dailyPriceAmountMinor} IS NULL OR ${t.dailyPriceAmountMinor} > 0`,
    ),
    check(
      'product_variants_daily_price_max',
      sql`${t.dailyPriceAmountMinor} IS NULL OR ${t.dailyPriceAmountMinor} <= 9007199254740991`,
    ),
    check('product_variants_currency_eur', sql`${t.currency} = 'EUR'`),
  ],
);

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

// ---------------------------------------------------------------------------
// Lot 4 — Prix, brouillon de réservation, allocations et idempotence (ADR-009).
// ---------------------------------------------------------------------------
// Note : les triggers de cohérence multi-tenant (check_booking_draft_org_consistency,
// check_booking_draft_line_org_consistency, check_allocation_consistency) sont définis
// en SQL dans la migration 0018 (ADR-004). Drizzle ne les représente pas dans le schéma
// TypeScript, mais ils sont actifs en base.

export const bookingDrafts = pgTable(
  'booking_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id),
    customerUserId: uuid('customer_user_id')
      .notNull()
      .references(() => users.id),
    status: bookingDraftStatus('status').notNull().default('DRAFT'),
    customerStartAt: timestamp('customer_start_at', { withTimezone: true }).notNull(),
    customerEndAt: timestamp('customer_end_at', { withTimezone: true }).notNull(),
    blockedStartAt: timestamp('blocked_start_at', { withTimezone: true }).notNull(),
    blockedEndAt: timestamp('blocked_end_at', { withTimezone: true }).notNull(),
    timezone: text('timezone').notNull(),
    prepBufferMinutes: integer('prep_buffer_minutes').notNull(),
    cleanupBufferMinutes: integer('cleanup_buffer_minutes').notNull(),
    currency: text('currency').notNull().default('EUR'),
    subtotalAmountMinor: bigint('subtotal_amount_minor', { mode: 'number' }).notNull(),
    mandatoryFeesAmountMinor: bigint('mandatory_fees_amount_minor', { mode: 'number' })
      .notNull()
      .default(0),
    totalAmountMinor: bigint('total_amount_minor', { mode: 'number' }).notNull(),
    taxStatus: taxStatus('tax_status').notNull().default('UNDETERMINED'),
    taxAmountMinor: bigint('tax_amount_minor', { mode: 'number' }),
    taxRateBps: integer('tax_rate_bps'),
    commissionAmountMinor: bigint('commission_amount_minor', { mode: 'number' }),
    billableUnit: text('billable_unit').notNull().default('DAY'),
    billableUnitCount: integer('billable_unit_count').notNull(),
    cancellationPolicySnapshot: jsonb('cancellation_policy_snapshot').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('booking_drafts_customer_period_valid', sql`${t.customerEndAt} > ${t.customerStartAt}`),
    check(
      'booking_drafts_blocked_includes_customer',
      sql`${t.blockedStartAt} <= ${t.customerStartAt} AND ${t.blockedEndAt} >= ${t.customerEndAt}`,
    ),
    check('booking_drafts_total_nonneg', sql`${t.totalAmountMinor} >= 0`),
    check('booking_drafts_subtotal_nonneg', sql`${t.subtotalAmountMinor} >= 0`),
    check('booking_drafts_mandatory_fees_nonneg', sql`${t.mandatoryFeesAmountMinor} >= 0`),
    check('booking_drafts_total_max_safe', sql`${t.totalAmountMinor} <= 9007199254740991`),
    check(
      'booking_drafts_tax_undetermined_null',
      sql`${t.taxStatus} <> 'UNDETERMINED' OR ${t.taxAmountMinor} IS NULL`,
    ),
    check(
      'booking_drafts_tax_not_applicable_zero',
      sql`${t.taxStatus} <> 'NOT_APPLICABLE' OR ${t.taxAmountMinor} = 0`,
    ),
    check(
      'booking_drafts_tax_applied_not_null',
      sql`${t.taxStatus} <> 'APPLIED' OR ${t.taxAmountMinor} IS NOT NULL`,
    ),
    check('booking_drafts_subtotal_max_safe', sql`${t.subtotalAmountMinor} <= 9007199254740991`),
    check(
      'booking_drafts_mandatory_fees_max_safe',
      sql`${t.mandatoryFeesAmountMinor} <= 9007199254740991`,
    ),
    check(
      'booking_drafts_tax_max_safe',
      sql`${t.taxAmountMinor} IS NULL OR ${t.taxAmountMinor} <= 9007199254740991`,
    ),
    check(
      'booking_drafts_commission_max_safe',
      sql`${t.commissionAmountMinor} IS NULL OR ${t.commissionAmountMinor} <= 9007199254740991`,
    ),
    check(
      'booking_drafts_total_equals_subtotal_plus_fees',
      sql`${t.totalAmountMinor} = ${t.subtotalAmountMinor} + ${t.mandatoryFeesAmountMinor}`,
    ),
    check('booking_drafts_billable_count_positive', sql`${t.billableUnitCount} > 0`),
    check('booking_drafts_billable_unit_day', sql`${t.billableUnit} = 'DAY'`),
    check('booking_drafts_currency_eur', sql`${t.currency} = 'EUR'`),
    check(
      'booking_drafts_held_requires_expires_at',
      sql`${t.status} NOT IN ('HELD', 'PAYMENT_PROCESSING') OR ${t.expiresAt} IS NOT NULL`,
    ),
    check(
      'booking_drafts_tax_nonneg',
      sql`${t.taxAmountMinor} IS NULL OR ${t.taxAmountMinor} >= 0`,
    ),
    check(
      'booking_drafts_commission_nonneg',
      sql`${t.commissionAmountMinor} IS NULL OR ${t.commissionAmountMinor} >= 0`,
    ),
    check(
      'booking_drafts_tax_rate_bps_undetermined_null',
      sql`${t.taxStatus} <> 'UNDETERMINED' OR ${t.taxRateBps} IS NULL`,
    ),
  ],
);

export const bookingDraftLines = pgTable(
  'booking_draft_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    draftId: uuid('draft_id')
      .notNull()
      .references(() => bookingDrafts.id),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id),
    quantity: integer('quantity').notNull(),
    unitPriceAmountMinor: bigint('unit_price_amount_minor', { mode: 'number' }).notNull(),
    billableUnitCount: integer('billable_unit_count').notNull(),
    lineTotalAmountMinor: bigint('line_total_amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('EUR'),
    variantSnapshot: jsonb('variant_snapshot').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('booking_draft_lines_quantity_positive', sql`${t.quantity} > 0`),
    check('booking_draft_lines_billable_count_positive', sql`${t.billableUnitCount} > 0`),
    check('booking_draft_lines_unit_price_nonneg', sql`${t.unitPriceAmountMinor} >= 0`),
    check('booking_draft_lines_line_total_nonneg', sql`${t.lineTotalAmountMinor} >= 0`),
    check(
      'booking_draft_lines_line_total_max_safe',
      sql`${t.lineTotalAmountMinor} <= 9007199254740991`,
    ),
    check(
      'booking_draft_lines_unit_price_max_safe',
      sql`${t.unitPriceAmountMinor} <= 9007199254740991`,
    ),
    check('booking_draft_lines_currency_eur', sql`${t.currency} = 'EUR'`),
  ],
);

export const allocations = pgTable(
  'allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    draftLineId: uuid('draft_line_id')
      .notNull()
      .references(() => bookingDraftLines.id),
    inventoryBlockId: uuid('inventory_block_id')
      .notNull()
      .references(() => inventoryBlocks.id),
    status: allocationStatus('status').notNull().default('ALLOCATED'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('allocations_draft_line_block_unique').on(t.draftLineId, t.inventoryBlockId),
    unique('allocations_inventory_block_unique').on(t.inventoryBlockId),
  ],
);

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    operation: text('operation').notNull(),
    key: text('key').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    status: text('status').notNull(),
    resourceId: uuid('resource_id'),
    responseStatusCode: integer('response_status_code'),
    responseBody: jsonb('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    pendingTimeoutAt: timestamp('pending_timeout_at', { withTimezone: true }),
  },
  (t) => [
    unique('idempotency_records_org_operation_key_unique').on(t.organizationId, t.operation, t.key),
    check(
      'idempotency_records_status_valid',
      sql`${t.status} IN ('PENDING', 'COMPLETED', 'FAILED')`,
    ),
    check('idempotency_records_fingerprint_hex', sql`${t.requestFingerprint} ~ '^[0-9a-f]{64}$'`),
    check(
      'idempotency_records_pending_has_timeout',
      sql`${t.status} <> 'PENDING' OR ${t.pendingTimeoutAt} IS NOT NULL`,
    ),
    check(
      'idempotency_records_pending_no_response',
      sql`${t.status} <> 'PENDING' OR (${t.resourceId} IS NULL AND ${t.responseStatusCode} IS NULL AND ${t.responseBody} IS NULL AND ${t.completedAt} IS NULL)`,
    ),
    check(
      'idempotency_records_completed_has_resource',
      sql`${t.status} <> 'COMPLETED' OR (${t.resourceId} IS NOT NULL AND ${t.responseStatusCode} IS NOT NULL AND ${t.responseBody} IS NOT NULL AND ${t.completedAt} IS NOT NULL)`,
    ),
    check(
      'idempotency_records_failed_has_response',
      sql`${t.status} <> 'FAILED' OR (${t.responseStatusCode} IS NOT NULL AND ${t.responseBody} IS NOT NULL AND ${t.completedAt} IS NOT NULL AND ${t.resourceId} IS NULL)`,
    ),
    check(
      'idempotency_records_status_code_range',
      sql`${t.responseStatusCode} IS NULL OR (${t.responseStatusCode} >= 100 AND ${t.responseStatusCode} <= 599)`,
    ),
  ],
);

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
export type BookingDraft = typeof bookingDrafts.$inferSelect;
export type NewBookingDraft = typeof bookingDrafts.$inferInsert;
export type BookingDraftLine = typeof bookingDraftLines.$inferSelect;
export type NewBookingDraftLine = typeof bookingDraftLines.$inferInsert;
export type Allocation = typeof allocations.$inferSelect;
export type NewAllocation = typeof allocations.$inferInsert;
export type IdempotencyRecord = typeof idempotencyRecords.$inferSelect;
export type NewIdempotencyRecord = typeof idempotencyRecords.$inferInsert;
