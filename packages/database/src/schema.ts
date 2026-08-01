import {
  bigint,
  boolean,
  check,
  customType,
  index,
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

// Lot 5 — Paiement Stripe Connect, confirmation et réconciliation (ADR-010).
export const paymentProvider = pgEnum('payment_provider', ['STRIPE']);

export const paymentEnvironment = pgEnum('payment_environment', ['TEST', 'LIVE']);

export const accountApiGeneration = pgEnum('account_api_generation', [
  'ACCOUNTS_V2',
  'ACCOUNTS_V1_CONTROLLER_PROPERTIES',
]);

export const onboardingStatus = pgEnum('onboarding_status', [
  'PENDING',
  'SUBMITTED',
  'ENABLED',
  'DISABLED',
  'REJECTED',
]);

export const capabilityStatus = pgEnum('capability_status', [
  'ACTIVE',
  'INACTIVE',
  'PENDING',
  'UNREQUESTED',
]);

export const settlementMerchantMode = pgEnum('settlement_merchant_mode', [
  'PLATFORM',
  'CONNECTED_ACCOUNT',
]);

export const chargeModel = pgEnum('charge_model', ['DESTINATION']);

export const paymentStatus = pgEnum('payment_status', [
  'PENDING_PROVIDER',
  'REQUIRES_PAYMENT_METHOD',
  'REQUIRES_ACTION',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);

export const paymentAttemptStatus = pgEnum('payment_attempt_status', [
  'PENDING_PROVIDER',
  'REQUIRES_PAYMENT_METHOD',
  'REQUIRES_ACTION',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);

export const webhookEventStatus = pgEnum('webhook_event_status', [
  'RECEIVED',
  'PROCESSED',
  'IGNORED',
  'FAILED',
]);

export const bookingStatus = pgEnum('booking_status', [
  'CONFIRMED',
  'READY_FOR_PICKUP',
  'ACTIVE',
  'RETURNED',
  'CLOSED',
  'CANCELLED',
  'REFUNDED',
]);

export const outboxEventStatus = pgEnum('outbox_event_status', [
  'PENDING',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
]);

export const refundReason = pgEnum('refund_reason', ['LATE_PAYMENT_NO_BOOKING', 'EXTERNAL_REFUND']);

export const refundStatus = pgEnum('refund_status', [
  'PENDING',
  'SUBMITTED',
  'SUCCEEDED',
  'FAILED',
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

// ---------------------------------------------------------------------------
// Lot 5 — Paiement Stripe Connect, confirmation et réconciliation (ADR-010).
// ---------------------------------------------------------------------------
// Note : les triggers de cohérence multi-tenant (before_check_payment_org_consistency,
// before_check_payment_attempt_org_consistency, before_check_booking_org_consistency,
// before_check_booking_line_org_consistency, before_check_booking_item_consistency,
// before_check_refund_org_consistency) sont définis en SQL dans la migration 0019
// (ADR-010). Drizzle ne les représente pas dans le schéma TypeScript, mais ils sont
// actifs en base.

export const organizationPaymentAccounts = pgTable(
  'organization_payment_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    provider: paymentProvider('provider').notNull().default('STRIPE'),
    environment: paymentEnvironment('environment').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    accountApiGeneration: accountApiGeneration('account_api_generation').notNull(),
    onboardingStatus: onboardingStatus('onboarding_status').notNull(),
    chargesEnabled: boolean('charges_enabled').notNull().default(false),
    payoutsEnabled: boolean('payouts_enabled').notNull().default(false),
    transfersCapabilityStatus: capabilityStatus('transfers_capability_status').notNull(),
    settlementMerchantMode: settlementMerchantMode('settlement_merchant_mode').notNull(),
    controllerConfigurationSnapshot: jsonb('controller_configuration_snapshot').notNull(),
    requirementsSnapshot: jsonb('requirements_snapshot').notNull(),
    lastProviderEventAt: timestamp('last_provider_event_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('organization_payment_accounts_org_provider_env_unique').on(
      t.organizationId,
      t.provider,
      t.environment,
    ),
    unique('organization_payment_accounts_provider_env_account_unique').on(
      t.provider,
      t.environment,
      t.providerAccountId,
    ),
    check('organization_payment_accounts_provider_stripe', sql`${t.provider} = 'STRIPE'`),
    index('organization_payment_accounts_organization_id_environment_index').on(
      t.organizationId,
      t.environment,
    ),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    draftId: uuid('draft_id')
      .notNull()
      .unique()
      .references(() => bookingDrafts.id),
    customerUserId: uuid('customer_user_id')
      .notNull()
      .references(() => users.id),
    status: paymentStatus('status').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('EUR'),
    taxStatus: taxStatus('tax_status').notNull(),
    taxAmountMinor: bigint('tax_amount_minor', { mode: 'number' }),
    taxRateBps: integer('tax_rate_bps'),
    taxRuleSnapshot: jsonb('tax_rule_snapshot'),
    commissionAmountMinor: bigint('commission_amount_minor', { mode: 'number' }).notNull(),
    commissionRuleSnapshot: jsonb('commission_rule_snapshot'),
    financialTermsVersion: text('financial_terms_version').notNull(),
    legalTermsVersion: text('legal_terms_version').notNull(),
    termsAcceptanceSnapshot: jsonb('terms_acceptance_snapshot').notNull(),
    connectedAccountId: text('connected_account_id').notNull(),
    onBehalfOfAccountId: text('on_behalf_of_account_id'),
    chargeModel: chargeModel('charge_model').notNull().default('DESTINATION'),
    settlementMerchantMode: settlementMerchantMode('settlement_merchant_mode').notNull(),
    environment: paymentEnvironment('environment').notNull(),
    processingStartedAt: timestamp('processing_started_at', { withTimezone: true }),
    processingDeadlineAt: timestamp('processing_deadline_at', { withTimezone: true }),
    succeededAt: timestamp('succeeded_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('payments_currency_eur', sql`${t.currency} = 'EUR'`),
    check('payments_amount_nonneg', sql`${t.amountMinor} >= 0`),
    check('payments_amount_max_safe', sql`${t.amountMinor} <= 9007199254740991`),
    check('payments_commission_nonneg', sql`${t.commissionAmountMinor} >= 0`),
    check('payments_commission_max_safe', sql`${t.commissionAmountMinor} <= 9007199254740991`),
    check('payments_commission_lte_amount', sql`${t.commissionAmountMinor} <= ${t.amountMinor}`),
    check('payments_tax_not_undetermined', sql`${t.taxStatus} <> 'UNDETERMINED'`),
    check(
      'payments_tax_not_applicable_zero',
      sql`${t.taxStatus} <> 'NOT_APPLICABLE' OR ${t.taxAmountMinor} = 0`,
    ),
    check(
      'payments_tax_applied_not_null',
      sql`${t.taxStatus} <> 'APPLIED' OR ${t.taxAmountMinor} IS NOT NULL`,
    ),
    check('payments_tax_nonneg', sql`${t.taxAmountMinor} IS NULL OR ${t.taxAmountMinor} >= 0`),
    check(
      'payments_tax_max_safe',
      sql`${t.taxAmountMinor} IS NULL OR ${t.taxAmountMinor} <= 9007199254740991`,
    ),
    check('payments_charge_model_destination', sql`${t.chargeModel} = 'DESTINATION'`),
    check(
      'payments_succeeded_has_timestamp',
      sql`${t.status} <> 'SUCCEEDED' OR ${t.succeededAt} IS NOT NULL`,
    ),
    check('payments_environment_check', sql`${t.environment} IN ('TEST', 'LIVE')`),
    index('payments_organization_id_status_index').on(t.organizationId, t.status),
    index('payments_non_terminal_processing_deadline_index')
      .on(t.status, t.processingDeadlineAt)
      .where(
        sql`${t.status} IN ('PENDING_PROVIDER', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING')`,
      ),
  ],
);

export const paymentAttempts = pgTable(
  'payment_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id),
    attemptNumber: integer('attempt_number').notNull(),
    status: paymentAttemptStatus('status').notNull(),
    providerPaymentIntentId: text('provider_payment_intent_id').unique(),
    providerLatestChargeId: text('provider_latest_charge_id'),
    providerIdempotencyKey: text('provider_idempotency_key').notNull().unique(),
    providerStatus: text('provider_status'),
    lastProviderErrorCode: text('last_provider_error_code'),
    reconcileAfter: timestamp('reconcile_after', { withTimezone: true }),
    reconcileLeaseUntil: timestamp('reconcile_lease_until', { withTimezone: true }),
    reconcileLeaseToken: uuid('reconcile_lease_token'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('payment_attempts_payment_attempt_number_unique').on(t.paymentId, t.attemptNumber),
    check('payment_attempts_attempt_number_positive', sql`${t.attemptNumber} > 0`),
    check(
      'payment_attempts_idempotency_key_nonempty',
      sql`length(btrim(${t.providerIdempotencyKey})) > 0`,
    ),
    index('payment_attempts_payment_id_status_index').on(t.paymentId, t.status),
    index('payment_attempts_reconcile_index')
      .on(t.status, t.reconcileAfter, t.reconcileLeaseUntil)
      .where(
        sql`${t.status} IN ('PENDING_PROVIDER', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING')`,
      ),
    check(
      'payment_attempts_provider_status_with_intent',
      sql`${t.providerPaymentIntentId} IS NULL OR ${t.providerStatus} IS NOT NULL`,
    ),
    check(
      'payment_attempts_lease_token_lease_until_consistent',
      sql`(${t.reconcileLeaseToken} IS NULL AND ${t.reconcileLeaseUntil} IS NULL) OR (${t.reconcileLeaseToken} IS NOT NULL AND ${t.reconcileLeaseUntil} IS NOT NULL)`,
    ),
    uniqueIndex('payment_attempts_single_non_terminal_attempt')
      .on(t.paymentId)
      .where(
        sql`${t.status} IN ('PENDING_PROVIDER', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING')`,
      ),
  ],
);

export const paymentWebhookEvents = pgTable(
  'payment_webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id),
    provider: paymentProvider('provider').notNull().default('STRIPE'),
    environment: paymentEnvironment('environment').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    providerEventCreatedAt: bigint('provider_event_created_at', { mode: 'number' }).notNull(),
    eventType: text('event_type').notNull(),
    providerObjectId: text('provider_object_id').notNull(),
    providerAccountId: text('provider_account_id'),
    apiVersion: text('api_version').notNull(),
    payloadSha256: text('payload_sha256').notNull(),
    normalizedPayload: jsonb('normalized_payload').notNull(),
    status: webhookEventStatus('status').notNull().default('RECEIVED'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    failureCode: text('failure_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('payment_webhook_events_provider_env_event_unique').on(
      t.provider,
      t.environment,
      t.providerEventId,
    ),
    check('payment_webhook_events_provider_stripe', sql`${t.provider} = 'STRIPE'`),
    check('payment_webhook_events_payload_sha256_hex', sql`${t.payloadSha256} ~ '^[0-9a-f]{64}$'`),
    index('payment_webhook_events_status_created_at_index').on(t.status, t.createdAt),
  ],
);

export const bookings = pgTable(
  'bookings',
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
    draftId: uuid('draft_id')
      .notNull()
      .unique()
      .references(() => bookingDrafts.id),
    paymentId: uuid('payment_id')
      .notNull()
      .unique()
      .references(() => payments.id),
    status: bookingStatus('status').notNull().default('CONFIRMED'),
    customerStartAt: timestamp('customer_start_at', { withTimezone: true }).notNull(),
    customerEndAt: timestamp('customer_end_at', { withTimezone: true }).notNull(),
    blockedStartAt: timestamp('blocked_start_at', { withTimezone: true }).notNull(),
    blockedEndAt: timestamp('blocked_end_at', { withTimezone: true }).notNull(),
    prepBufferMinutes: integer('prep_buffer_minutes').notNull(),
    cleanupBufferMinutes: integer('cleanup_buffer_minutes').notNull(),
    currency: text('currency').notNull().default('EUR'),
    subtotalAmountMinor: bigint('subtotal_amount_minor', { mode: 'number' }).notNull(),
    mandatoryFeesAmountMinor: bigint('mandatory_fees_amount_minor', { mode: 'number' })
      .notNull()
      .default(0),
    taxStatus: taxStatus('tax_status').notNull(),
    taxAmountMinor: bigint('tax_amount_minor', { mode: 'number' }),
    taxRateBps: integer('tax_rate_bps'),
    taxRuleSnapshot: jsonb('tax_rule_snapshot'),
    commissionAmountMinor: bigint('commission_amount_minor', { mode: 'number' }).notNull(),
    commissionRuleSnapshot: jsonb('commission_rule_snapshot'),
    totalAmountMinor: bigint('total_amount_minor', { mode: 'number' }).notNull(),
    cancellationPolicySnapshot: jsonb('cancellation_policy_snapshot').notNull(),
    termsAcceptanceSnapshot: jsonb('terms_acceptance_snapshot').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('bookings_currency_eur', sql`${t.currency} = 'EUR'`),
    check('bookings_customer_period_valid', sql`${t.customerEndAt} > ${t.customerStartAt}`),
    check('bookings_total_nonneg', sql`${t.totalAmountMinor} >= 0`),
    check('bookings_total_max_safe', sql`${t.totalAmountMinor} <= 9007199254740991`),
    check('bookings_subtotal_nonneg', sql`${t.subtotalAmountMinor} >= 0`),
    check('bookings_mandatory_fees_nonneg', sql`${t.mandatoryFeesAmountMinor} >= 0`),
    check('bookings_tax_not_undetermined', sql`${t.taxStatus} <> 'UNDETERMINED'`),
    check(
      'bookings_tax_not_applicable_zero',
      sql`${t.taxStatus} <> 'NOT_APPLICABLE' OR ${t.taxAmountMinor} = 0`,
    ),
    check(
      'bookings_tax_applied_not_null',
      sql`${t.taxStatus} <> 'APPLIED' OR ${t.taxAmountMinor} IS NOT NULL`,
    ),
    check(
      'bookings_total_equals_subtotal_plus_fees',
      sql`${t.totalAmountMinor} = ${t.subtotalAmountMinor} + ${t.mandatoryFeesAmountMinor}`,
    ),
    check('bookings_commission_nonneg', sql`${t.commissionAmountMinor} >= 0`),
    check(
      'bookings_commission_lte_total',
      sql`${t.commissionAmountMinor} <= ${t.totalAmountMinor}`,
    ),
    index('bookings_organization_id_status_customer_start_at_index').on(
      t.organizationId,
      t.status,
      t.customerStartAt,
    ),
  ],
);

export const bookingLines = pgTable(
  'booking_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
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
    unique('booking_lines_booking_variant_unique').on(t.bookingId, t.variantId),
    check('booking_lines_quantity_positive', sql`${t.quantity} > 0`),
    check('booking_lines_billable_count_positive', sql`${t.billableUnitCount} > 0`),
    check('booking_lines_unit_price_nonneg', sql`${t.unitPriceAmountMinor} >= 0`),
    check('booking_lines_line_total_nonneg', sql`${t.lineTotalAmountMinor} >= 0`),
    check('booking_lines_line_total_max_safe', sql`${t.lineTotalAmountMinor} <= 9007199254740991`),
    check('booking_lines_unit_price_max_safe', sql`${t.unitPriceAmountMinor} <= 9007199254740991`),
    check('booking_lines_currency_eur', sql`${t.currency} = 'EUR'`),
  ],
);

export const bookingItems = pgTable(
  'booking_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    bookingLineId: uuid('booking_line_id')
      .notNull()
      .references(() => bookingLines.id),
    inventoryItemId: uuid('inventory_item_id')
      .notNull()
      .references(() => inventoryItems.id),
    sourceHoldBlockId: uuid('source_hold_block_id').references(() => inventoryBlocks.id),
    bookingBlockId: uuid('booking_block_id')
      .notNull()
      .references(() => inventoryBlocks.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('booking_items_booking_inventory_item_unique').on(t.bookingId, t.inventoryItemId),
    uniqueIndex('booking_items_source_hold_block_unique')
      .on(t.sourceHoldBlockId)
      .where(sql`${t.sourceHoldBlockId} IS NOT NULL`),
    unique('booking_items_booking_block_unique').on(t.bookingBlockId),
  ],
);

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    eventVersion: text('event_version').notNull(),
    payload: jsonb('payload').notNull(),
    status: outboxEventStatus('status').notNull().default('PENDING'),
    attemptCount: integer('attempt_count').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    leaseToken: uuid('lease_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('outbox_events_attempt_count_nonneg', sql`${t.attemptCount} >= 0`),
    check('outbox_events_idempotency_key_nonempty', sql`length(btrim(${t.idempotencyKey})) > 0`),
    check(
      'outbox_events_lease_token_lease_until_consistent',
      sql`(${t.leaseToken} IS NULL AND ${t.leaseUntil} IS NULL) OR (${t.leaseToken} IS NOT NULL AND ${t.leaseUntil} IS NOT NULL)`,
    ),
    index('outbox_events_status_available_at_created_at_index')
      .on(t.status, t.availableAt, t.createdAt)
      .where(sql`${t.status} IN ('PENDING', 'PROCESSING')`),
    index('outbox_events_lease_until_index')
      .on(t.leaseUntil)
      .where(sql`${t.status} IN ('PENDING', 'PROCESSING')`),
  ],
);

export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id),
    reason: refundReason('reason').notNull(),
    status: refundStatus('status').notNull().default('PENDING'),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('EUR'),
    providerRefundId: text('provider_refund_id').unique(),
    providerIdempotencyKey: text('provider_idempotency_key').notNull().unique(),
    reverseTransfer: boolean('reverse_transfer').notNull().default(true),
    refundApplicationFee: boolean('refund_application_fee').notNull().default(true),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    succeededAt: timestamp('succeeded_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    failureCode: text('failure_code'),
    providerEventCreatedAt: bigint('provider_event_created_at', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('refunds_late_payment_unique')
      .on(t.paymentId, t.reason)
      .where(sql`${t.reason} = 'LATE_PAYMENT_NO_BOOKING'`),
    check('refunds_currency_eur', sql`${t.currency} = 'EUR'`),
    check('refunds_amount_positive', sql`${t.amountMinor} > 0`),
    check('refunds_amount_max_safe', sql`${t.amountMinor} <= 9007199254740991`),
    check(
      'refunds_late_payment_reverse_transfer',
      sql`${t.reason} <> 'LATE_PAYMENT_NO_BOOKING' OR ${t.reverseTransfer} = true`,
    ),
    check(
      'refunds_late_payment_refund_application_fee',
      sql`${t.reason} <> 'LATE_PAYMENT_NO_BOOKING' OR ${t.refundApplicationFee} = true`,
    ),
    index('refunds_status_requested_at_index').on(t.status, t.requestedAt),
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
export type OrganizationPaymentAccount = typeof organizationPaymentAccounts.$inferSelect;
export type NewOrganizationPaymentAccount = typeof organizationPaymentAccounts.$inferInsert;
export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type PaymentAttempt = typeof paymentAttempts.$inferSelect;
export type NewPaymentAttempt = typeof paymentAttempts.$inferInsert;
export type PaymentWebhookEvent = typeof paymentWebhookEvents.$inferSelect;
export type NewPaymentWebhookEvent = typeof paymentWebhookEvents.$inferInsert;
export type Booking = typeof bookings.$inferSelect;
export type NewBooking = typeof bookings.$inferInsert;
export type BookingLine = typeof bookingLines.$inferSelect;
export type NewBookingLine = typeof bookingLines.$inferInsert;
export type BookingItem = typeof bookingItems.$inferSelect;
export type NewBookingItem = typeof bookingItems.$inferInsert;
export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;
export type Refund = typeof refunds.$inferSelect;
export type NewRefund = typeof refunds.$inferInsert;
