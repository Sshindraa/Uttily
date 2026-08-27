import {
  bigint,
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
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
    publicDisplayName: text('public_display_name'),
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
    check(
      'organizations_public_display_name_not_empty',
      sql`${t.publicDisplayName} IS NULL OR length(btrim(${t.publicDisplayName})) > 0`,
    ),
  ],
);

export const countries = pgTable(
  'countries',
  {
    countryCode: text('country_code').primaryKey(),
    isActive: boolean('is_active').notNull().default(false),
    defaultCurrency: text('default_currency').notNull(),
    defaultLocale: text('default_locale').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('countries_country_code_format', sql`${t.countryCode} ~ '^[A-Z]{2}$'`),
    check('countries_default_currency_iso', sql`${t.defaultCurrency} ~ '^[A-Z]{3}$'`),
    check('countries_default_locale_format', sql`${t.defaultLocale} ~ '^[a-z]{2}(-[A-Z]{2})?$'`),
    index('countries_is_active_index')
      .on(t.isActive)
      .where(sql`${t.isActive} = true`),
  ],
);

export const destinations = pgTable(
  'destinations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publicId: uuid('public_id').notNull().unique().defaultRandom(),
    slug: text('slug').notNull().unique(),
    countryCode: text('country_code')
      .notNull()
      .references(() => countries.countryCode),
    placeType: text('place_type').notNull(),
    center: geometryPoint('center').notNull(),
    bboxSouth: doublePrecision('bbox_south').notNull(),
    bboxWest: doublePrecision('bbox_west').notNull(),
    bboxNorth: doublePrecision('bbox_north').notNull(),
    bboxEast: doublePrecision('bbox_east').notNull(),
    isActive: boolean('is_active').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('destinations_slug_format', sql`${t.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`),
    check(
      'destinations_place_type_valid',
      sql`${t.placeType} IN ('COUNTRY', 'REGION', 'CITY', 'LOCALITY', 'POINT_OF_INTEREST')`,
    ),
    check('destinations_sort_order_nonneg', sql`${t.sortOrder} >= 0`),
    check('destinations_center_not_empty', sql`NOT ST_IsEmpty(${t.center})`),
    check(
      'destinations_center_longitude_range',
      sql`ST_X(${t.center}) >= -180 AND ST_X(${t.center}) <= 180`,
    ),
    check(
      'destinations_center_latitude_range',
      sql`ST_Y(${t.center}) >= -90 AND ST_Y(${t.center}) <= 90`,
    ),
    check(
      'destinations_bbox_lat_range',
      sql`${t.bboxSouth} >= -90 AND ${t.bboxSouth} <= 90 AND ${t.bboxNorth} >= -90 AND ${t.bboxNorth} <= 90`,
    ),
    check(
      'destinations_bbox_lon_range',
      sql`${t.bboxWest} >= -180 AND ${t.bboxWest} <= 180 AND ${t.bboxEast} >= -180 AND ${t.bboxEast} <= 180`,
    ),
    // bbox_south < bbox_north (strictement). NE PAS imposer bbox_west <= bbox_east :
    // une zone traversant l'antiméridien (ex. Pacifique) a bbox_west > bbox_east.
    check('destinations_bbox_south_lt_north', sql`${t.bboxSouth} < ${t.bboxNorth}`),
    check('destinations_active_not_deleted', sql`NOT ${t.isActive} OR ${t.deletedAt} IS NULL`),
    index('destinations_active_by_country_type_order_index')
      .on(t.countryCode, t.placeType, t.sortOrder)
      .where(sql`${t.isActive} = true AND ${t.deletedAt} IS NULL`),
  ],
);

export const destinationTranslations = pgTable(
  'destination_translations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    destinationId: uuid('destination_id')
      .notNull()
      .references(() => destinations.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    label: text('label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('destination_translations_destination_locale_unique').on(t.destinationId, t.locale),
    check('destination_translations_locale_format', sql`${t.locale} ~ '^[a-z]{2}(-[A-Z]{2})?$'`),
    check('destination_translations_label_not_empty', sql`length(btrim(${t.label})) > 0`),
    index('destination_translations_destination_locale_index').on(t.destinationId, t.locale),
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
    publicId: uuid('public_id').notNull().unique().defaultRandom(),
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
    isPubliclyListed: boolean('is_publicly_listed').notNull().default(false),
    prepBufferMinutes: integer('prep_buffer_minutes').notNull().default(30),
    cleanupBufferMinutes: integer('cleanup_buffer_minutes').notNull().default(30),
    // Lot 7 G7P-A — devise opérationnelle du magasin (backfill depuis
    // organizations.default_currency, migration 0032). Autorité finale pour les
    // plans tarifaires locaux ; organizations.default_currency reste un défaut
    // d'onboarding.
    operatingCurrency: text('operating_currency').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('locations_slug_format', sql`${t.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`),
    check('locations_operating_currency_iso', sql`${t.operatingCurrency} ~ '^[A-Z]{3}$'`),
    // Slug unique par organisation (pas globalement). Cohérent avec migration 0005.
    unique('locations_organization_slug_unique').on(t.organizationId, t.slug),
    check('locations_prep_buffer_nonneg', sql`${t.prepBufferMinutes} >= 0`),
    check('locations_cleanup_buffer_nonneg', sql`${t.cleanupBufferMinutes} >= 0`),
    check(
      'locations_public_listing_requirements',
      sql`NOT ${t.isPubliclyListed} OR (${t.pickupEnabled} AND ${t.geoPoint} IS NOT NULL AND ${t.deletedAt} IS NULL AND ${t.addressLine1} IS NOT NULL AND length(btrim(${t.addressLine1})) > 0 AND ${t.city} IS NOT NULL AND length(btrim(${t.city})) > 0 AND ${t.countryCode} IS NOT NULL AND ${t.countryCode} ~ '^[A-Z]{2}$')`,
    ),
    index('locations_publicly_listed_index')
      .on(t.isPubliclyListed)
      .where(sql`${t.isPubliclyListed} = true`),
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
  actorUserId: uuid('actor_user_id').references(() => users.id, {
    onDelete: 'restrict',
  }),
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

export const cancellationActorReason = pgEnum('cancellation_actor_reason', [
  'CUSTOMER_CANCELLATION',
  'MERCHANT_CANCELLATION',
  'PLATFORM_CANCELLATION',
  'PAYMENT_COMPENSATION',
]);

export const refundReason = pgEnum('refund_reason', [
  'LATE_PAYMENT_NO_BOOKING',
  'EXTERNAL_REFUND',
  'BOOKING_MODIFICATION',
  'AMENDMENT_COMPENSATION',
  'CUSTOMER_CANCELLATION',
  'MERCHANT_CANCELLATION',
  'PLATFORM_CANCELLATION',
]);

export const refundStatus = pgEnum('refund_status', [
  'PENDING',
  'SUBMITTED',
  'SUCCEEDED',
  'FAILED',
  'FAILED_REQUIRES_MANUAL_ACTION',
  'SETTLED_OFF_PLATFORM',
]);

// Lot 6 — Fulfillment opérationnel (ADR-012).
export const fulfillmentEventType = pgEnum('fulfillment_event_type', [
  'PREPARED',
  'PICKED_UP',
  'RETURNED',
  'CLOSED',
]);

export const conditionReportPhase = pgEnum('condition_report_phase', ['PICKUP', 'RETURN']);

// Lot 7 G7P-A — plans tarifaires flexibles (ADR-018, migration 0032).
export const pricingPlanType = pgEnum('pricing_plan_type', ['HOURLY', 'FIXED_DURATION', 'DAILY']);
export const pricingLifecycleState = pgEnum('pricing_lifecycle_state', [
  'DRAFT',
  'ACTIVE',
  'RETIRED',
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
    publicId: uuid('public_id').notNull().unique().defaultRandom(),
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
    publicId: uuid('public_id').notNull().unique().defaultRandom(),
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
    check('product_variants_currency_iso', sql`${t.currency} ~ '^[A-Z]{3}$'`),
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
    // G7P-B2-A — colonnes de snapshot de prix flexible
    pricingSnapshotVersion: text('pricing_snapshot_version').notNull().default('legacy-daily-v1'),
    pricingAlgorithmVersion: text('pricing_algorithm_version'),
    pricingRoundingRuleVersion: text('pricing_rounding_rule_version'),
    pricingIntentType: text('pricing_intent_type'),
    pricingIntentSnapshot: jsonb('pricing_intent_snapshot'),
    pricingResolvedLocale: text('pricing_resolved_locale'),
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
    check(
      'booking_drafts_billable_unit_valid',
      sql`${t.billableUnit} IN ('DAY', 'HOURLY', 'FIXED_DURATION', 'DAILY', 'MINUTE')`,
    ),
    check(
      'booking_drafts_legacy_billable_unit_day',
      sql`${t.pricingSnapshotVersion} <> 'legacy-daily-v1' OR ${t.billableUnit} = 'DAY'`,
    ),
    check(
      'booking_drafts_flexible_billable_unit_by_intent',
      sql`${t.pricingSnapshotVersion} <> 'flexible-pricing-v1' OR ((${t.pricingIntentType} <> 'TIME_RANGE' OR ${t.billableUnit} = 'MINUTE') AND (${t.pricingIntentType} <> 'DAY_RANGE' OR ${t.billableUnit} = 'DAY'))`,
    ),
    check(
      'booking_drafts_pricing_snapshot_version_valid',
      sql`${t.pricingSnapshotVersion} IN ('legacy-daily-v1', 'flexible-pricing-v1')`,
    ),
    check(
      'booking_drafts_pricing_intent_type_valid',
      sql`${t.pricingIntentType} IS NULL OR ${t.pricingIntentType} IN ('TIME_RANGE', 'DAY_RANGE')`,
    ),
    check(
      'booking_drafts_flexible_metadata_exact',
      sql`${t.pricingSnapshotVersion} <> 'flexible-pricing-v1' OR (${t.pricingAlgorithmVersion} = 'flexible-pricing-v1' AND ${t.pricingRoundingRuleVersion} = 'half-up-v1' AND ${t.pricingIntentType} IN ('TIME_RANGE', 'DAY_RANGE') AND ${t.pricingIntentSnapshot} IS NOT NULL AND jsonb_typeof(${t.pricingIntentSnapshot}) = 'object' AND length(btrim(${t.pricingResolvedLocale})) > 0)`,
    ),
    check(
      'booking_drafts_legacy_metadata_null',
      sql`${t.pricingSnapshotVersion} <> 'legacy-daily-v1' OR (${t.pricingAlgorithmVersion} IS NULL AND ${t.pricingRoundingRuleVersion} IS NULL AND ${t.pricingIntentType} IS NULL AND ${t.pricingIntentSnapshot} IS NULL AND ${t.pricingResolvedLocale} IS NULL AND ${t.billableUnit} = 'DAY')`,
    ),
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
    // G7P-B2-A — colonnes de snapshot de prix flexible
    // NOTE: DEFERRABLE INITIALLY DEFERRED is set in the migration SQL (0033).
    // Drizzle's .references() API does not support DEFERRABLE options.
    pricingPlanId: uuid('pricing_plan_id').references(() => pricingPlans.id),
    pricingPlanVersion: integer('pricing_plan_version'),
    pricingPlanType: text('pricing_plan_type'),
    pricingPublicLabel: text('pricing_public_label'),
    pricingRequestedDurationMinutes: integer('pricing_requested_duration_minutes'),
    pricingBilledDurationMinutes: integer('pricing_billed_duration_minutes'),
    pricingCoveredDurationMinutes: integer('pricing_covered_duration_minutes'),
    pricingBilledDays: integer('pricing_billed_days'),
    pricingSelectedWindow: jsonb('pricing_selected_window'),
    pricingDiscountThresholdDays: integer('pricing_discount_threshold_days'),
    pricingDiscountPercent: integer('pricing_discount_percent'),
    pricingAmountBeforeDiscountMinor: bigint('pricing_amount_before_discount_minor', {
      mode: 'number',
    }),
    pricingAmountAfterDiscountMinor: bigint('pricing_amount_after_discount_minor', {
      mode: 'number',
    }),
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
    // G7P-B2-A — contraintes CHECK de snapshot flexible
    check(
      'booking_draft_lines_pricing_plan_type_valid',
      sql`${t.pricingPlanType} IS NULL OR ${t.pricingPlanType} IN ('HOURLY', 'FIXED_DURATION', 'DAILY')`,
    ),
    check(
      'booking_draft_lines_pricing_amount_before_nonneg',
      sql`${t.pricingAmountBeforeDiscountMinor} IS NULL OR ${t.pricingAmountBeforeDiscountMinor} >= 0`,
    ),
    check(
      'booking_draft_lines_pricing_amount_before_max_safe',
      sql`${t.pricingAmountBeforeDiscountMinor} IS NULL OR ${t.pricingAmountBeforeDiscountMinor} <= 9007199254740991`,
    ),
    check(
      'booking_draft_lines_pricing_amount_after_nonneg',
      sql`${t.pricingAmountAfterDiscountMinor} IS NULL OR ${t.pricingAmountAfterDiscountMinor} >= 0`,
    ),
    check(
      'booking_draft_lines_pricing_amount_after_max_safe',
      sql`${t.pricingAmountAfterDiscountMinor} IS NULL OR ${t.pricingAmountAfterDiscountMinor} <= 9007199254740991`,
    ),
    check(
      'booking_draft_lines_pricing_amount_before_gte_after',
      sql`${t.pricingAmountBeforeDiscountMinor} IS NULL OR ${t.pricingAmountAfterDiscountMinor} IS NULL OR ${t.pricingAmountBeforeDiscountMinor} >= ${t.pricingAmountAfterDiscountMinor}`,
    ),
    check(
      'booking_draft_lines_pricing_discount_percent_range',
      sql`${t.pricingDiscountPercent} IS NULL OR (${t.pricingDiscountPercent} >= 0 AND ${t.pricingDiscountPercent} <= 100)`,
    ),
    check(
      'booking_draft_lines_pricing_discount_threshold_daily_only',
      sql`${t.pricingDiscountThresholdDays} IS NULL OR ${t.pricingPlanType} = 'DAILY'`,
    ),
    check(
      'booking_draft_lines_pricing_hourly_requires_billed',
      sql`${t.pricingPlanType} <> 'HOURLY' OR ${t.pricingBilledDurationMinutes} IS NOT NULL`,
    ),
    check(
      'booking_draft_lines_pricing_fixed_requires_covered',
      sql`${t.pricingPlanType} <> 'FIXED_DURATION' OR ${t.pricingCoveredDurationMinutes} IS NOT NULL`,
    ),
    check(
      'booking_draft_lines_pricing_daily_requires_days_and_amounts',
      sql`${t.pricingPlanType} <> 'DAILY' OR (${t.pricingBilledDays} IS NOT NULL AND ${t.pricingAmountBeforeDiscountMinor} IS NOT NULL AND ${t.pricingAmountAfterDiscountMinor} IS NOT NULL)`,
    ),
    check(
      'booking_draft_lines_pricing_billed_days_positive',
      sql`${t.pricingBilledDays} IS NULL OR ${t.pricingBilledDays} > 0`,
    ),
    check(
      'booking_draft_lines_pricing_billed_duration_positive',
      sql`${t.pricingBilledDurationMinutes} IS NULL OR ${t.pricingBilledDurationMinutes} > 0`,
    ),
    check(
      'booking_draft_lines_pricing_covered_duration_positive',
      sql`${t.pricingCoveredDurationMinutes} IS NULL OR ${t.pricingCoveredDurationMinutes} > 0`,
    ),
    check(
      'booking_draft_lines_pricing_requested_duration_positive',
      sql`${t.pricingRequestedDurationMinutes} IS NULL OR ${t.pricingRequestedDurationMinutes} > 0`,
    ),
    check(
      'booking_draft_lines_pricing_day_range_requires_daily',
      sql`${t.pricingPlanType} IS NULL OR ${t.pricingPlanType} = 'DAILY' OR ${t.pricingDiscountThresholdDays} IS NULL`,
    ),
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
    timezone: text('timezone').notNull().default('UTC'),
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
    billableUnit: text('billable_unit').notNull().default('DAY'),
    billableUnitCount: integer('billable_unit_count').notNull().default(1),
    cancellationPolicySnapshot: jsonb('cancellation_policy_snapshot').notNull(),
    termsAcceptanceSnapshot: jsonb('terms_acceptance_snapshot').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // G7P-B2-A — colonnes de snapshot de prix flexible
    pricingSnapshotVersion: text('pricing_snapshot_version').notNull().default('legacy-daily-v1'),
    pricingAlgorithmVersion: text('pricing_algorithm_version'),
    pricingRoundingRuleVersion: text('pricing_rounding_rule_version'),
    pricingIntentType: text('pricing_intent_type'),
    pricingIntentSnapshot: jsonb('pricing_intent_snapshot'),
    pricingResolvedLocale: text('pricing_resolved_locale'),
  },
  (t) => [
    check('bookings_currency_eur', sql`${t.currency} = 'EUR'`),
    check('bookings_customer_period_valid', sql`${t.customerEndAt} > ${t.customerStartAt}`),
    check('bookings_total_nonneg', sql`${t.totalAmountMinor} >= 0`),
    check('bookings_total_max_safe', sql`${t.totalAmountMinor} <= 9007199254740991`),
    check('bookings_subtotal_nonneg', sql`${t.subtotalAmountMinor} >= 0`),
    check('bookings_mandatory_fees_nonneg', sql`${t.mandatoryFeesAmountMinor} >= 0`),
    check('bookings_tax_not_undetermined', sql`${t.taxStatus} <> 'UNDETERMINED'`),
    // G7P-B2-A — contraintes CHECK de snapshot flexible
    check(
      'bookings_pricing_snapshot_version_valid',
      sql`${t.pricingSnapshotVersion} IN ('legacy-daily-v1', 'flexible-pricing-v1')`,
    ),
    check(
      'bookings_pricing_intent_type_valid',
      sql`${t.pricingIntentType} IS NULL OR ${t.pricingIntentType} IN ('TIME_RANGE', 'DAY_RANGE')`,
    ),
    check(
      'bookings_flexible_metadata_exact',
      sql`${t.pricingSnapshotVersion} <> 'flexible-pricing-v1' OR (${t.pricingAlgorithmVersion} = 'flexible-pricing-v1' AND ${t.pricingRoundingRuleVersion} = 'half-up-v1' AND ${t.pricingIntentType} IN ('TIME_RANGE', 'DAY_RANGE') AND ${t.pricingIntentSnapshot} IS NOT NULL AND jsonb_typeof(${t.pricingIntentSnapshot}) = 'object' AND length(btrim(${t.pricingResolvedLocale})) > 0)`,
    ),
    check(
      'bookings_legacy_metadata_null',
      sql`${t.pricingSnapshotVersion} <> 'legacy-daily-v1' OR (${t.pricingAlgorithmVersion} IS NULL AND ${t.pricingRoundingRuleVersion} IS NULL AND ${t.pricingIntentType} IS NULL AND ${t.pricingIntentSnapshot} IS NULL AND ${t.pricingResolvedLocale} IS NULL AND ${t.billableUnit} = 'DAY')`,
    ),
    check(
      'bookings_flexible_billable_unit_by_intent',
      sql`${t.pricingSnapshotVersion} <> 'flexible-pricing-v1' OR ((${t.pricingIntentType} <> 'TIME_RANGE' OR ${t.billableUnit} = 'MINUTE') AND (${t.pricingIntentType} <> 'DAY_RANGE' OR ${t.billableUnit} = 'DAY'))`,
    ),
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
    // G7P-B2-A — colonnes de snapshot de prix flexible
    // NOTE: DEFERRABLE INITIALLY DEFERRED is set in the migration SQL (0033).
    // Drizzle's .references() API does not support DEFERRABLE options.
    pricingPlanId: uuid('pricing_plan_id').references(() => pricingPlans.id),
    pricingPlanVersion: integer('pricing_plan_version'),
    pricingPlanType: text('pricing_plan_type'),
    pricingPublicLabel: text('pricing_public_label'),
    pricingRequestedDurationMinutes: integer('pricing_requested_duration_minutes'),
    pricingBilledDurationMinutes: integer('pricing_billed_duration_minutes'),
    pricingCoveredDurationMinutes: integer('pricing_covered_duration_minutes'),
    pricingBilledDays: integer('pricing_billed_days'),
    pricingSelectedWindow: jsonb('pricing_selected_window'),
    pricingDiscountThresholdDays: integer('pricing_discount_threshold_days'),
    pricingDiscountPercent: integer('pricing_discount_percent'),
    pricingAmountBeforeDiscountMinor: bigint('pricing_amount_before_discount_minor', {
      mode: 'number',
    }),
    pricingAmountAfterDiscountMinor: bigint('pricing_amount_after_discount_minor', {
      mode: 'number',
    }),
    // G7P-B2-A — source de vérité explicite pour la copie draft -> booking
    sourceDraftLineId: uuid('source_draft_line_id').references(() => bookingDraftLines.id),
  },
  (t) => [
    unique('booking_lines_source_draft_line_id_unique').on(t.sourceDraftLineId),
    unique('booking_lines_booking_variant_unique').on(t.bookingId, t.variantId),
    check('booking_lines_quantity_positive', sql`${t.quantity} > 0`),
    check('booking_lines_billable_count_positive', sql`${t.billableUnitCount} > 0`),
    check('booking_lines_unit_price_nonneg', sql`${t.unitPriceAmountMinor} >= 0`),
    check('booking_lines_line_total_nonneg', sql`${t.lineTotalAmountMinor} >= 0`),
    check('booking_lines_line_total_max_safe', sql`${t.lineTotalAmountMinor} <= 9007199254740991`),
    check('booking_lines_unit_price_max_safe', sql`${t.unitPriceAmountMinor} <= 9007199254740991`),
    // G7P-B2-A — contraintes CHECK de snapshot flexible
    check(
      'booking_lines_pricing_plan_type_valid',
      sql`${t.pricingPlanType} IS NULL OR ${t.pricingPlanType} IN ('HOURLY', 'FIXED_DURATION', 'DAILY')`,
    ),
    check(
      'booking_lines_pricing_amount_before_nonneg',
      sql`${t.pricingAmountBeforeDiscountMinor} IS NULL OR ${t.pricingAmountBeforeDiscountMinor} >= 0`,
    ),
    check(
      'booking_lines_pricing_amount_before_max_safe',
      sql`${t.pricingAmountBeforeDiscountMinor} IS NULL OR ${t.pricingAmountBeforeDiscountMinor} <= 9007199254740991`,
    ),
    check(
      'booking_lines_pricing_amount_after_nonneg',
      sql`${t.pricingAmountAfterDiscountMinor} IS NULL OR ${t.pricingAmountAfterDiscountMinor} >= 0`,
    ),
    check(
      'booking_lines_pricing_amount_after_max_safe',
      sql`${t.pricingAmountAfterDiscountMinor} IS NULL OR ${t.pricingAmountAfterDiscountMinor} <= 9007199254740991`,
    ),
    check(
      'booking_lines_pricing_amount_before_gte_after',
      sql`${t.pricingAmountBeforeDiscountMinor} IS NULL OR ${t.pricingAmountAfterDiscountMinor} IS NULL OR ${t.pricingAmountBeforeDiscountMinor} >= ${t.pricingAmountAfterDiscountMinor}`,
    ),
    check(
      'booking_lines_pricing_discount_percent_range',
      sql`${t.pricingDiscountPercent} IS NULL OR (${t.pricingDiscountPercent} >= 0 AND ${t.pricingDiscountPercent} <= 100)`,
    ),
    check(
      'booking_lines_pricing_discount_threshold_daily_only',
      sql`${t.pricingDiscountThresholdDays} IS NULL OR ${t.pricingPlanType} = 'DAILY'`,
    ),
    check(
      'booking_lines_pricing_hourly_requires_billed',
      sql`${t.pricingPlanType} <> 'HOURLY' OR ${t.pricingBilledDurationMinutes} IS NOT NULL`,
    ),
    check(
      'booking_lines_pricing_fixed_requires_covered',
      sql`${t.pricingPlanType} <> 'FIXED_DURATION' OR ${t.pricingCoveredDurationMinutes} IS NOT NULL`,
    ),
    check(
      'booking_lines_pricing_daily_requires_days_and_amounts',
      sql`${t.pricingPlanType} <> 'DAILY' OR (${t.pricingBilledDays} IS NOT NULL AND ${t.pricingAmountBeforeDiscountMinor} IS NOT NULL AND ${t.pricingAmountAfterDiscountMinor} IS NOT NULL)`,
    ),
    check(
      'booking_lines_pricing_billed_days_positive',
      sql`${t.pricingBilledDays} IS NULL OR ${t.pricingBilledDays} > 0`,
    ),
    check(
      'booking_lines_pricing_billed_duration_positive',
      sql`${t.pricingBilledDurationMinutes} IS NULL OR ${t.pricingBilledDurationMinutes} > 0`,
    ),
    check(
      'booking_lines_pricing_covered_duration_positive',
      sql`${t.pricingCoveredDurationMinutes} IS NULL OR ${t.pricingCoveredDurationMinutes} > 0`,
    ),
    check(
      'booking_lines_pricing_requested_duration_positive',
      sql`${t.pricingRequestedDurationMinutes} IS NULL OR ${t.pricingRequestedDurationMinutes} > 0`,
    ),
    check(
      'booking_lines_pricing_day_range_requires_daily',
      sql`${t.pricingPlanType} IS NULL OR ${t.pricingPlanType} = 'DAILY' OR ${t.pricingDiscountThresholdDays} IS NULL`,
    ),
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
    // G7M-A : payment_id devient nullable pour supporter les refunds
    // d'amendement (AMENDMENT_COMPENSATION référence amendment_payment_id).
    // Contrainte XOR : exactement une origine non-null (CHECK en migration).
    paymentId: uuid('payment_id').references(() => payments.id),
    amendmentPaymentId: uuid('amendment_payment_id').references(() => amendmentPayments.id),
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
    // G7M-A : colonnes de résolution manuelle auditée (ADR-023 §10.7).
    settledOffPlatformAt: timestamp('settled_off_platform_at', { withTimezone: true }),
    settledOffPlatformBy: uuid('settled_off_platform_by').references(() => users.id),
    settlementNotes: text('settlement_notes'),
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
    // G7M-A : XOR — exactement une origine de paiement non-null.
    check(
      'refunds_payment_origin_xor',
      sql`(${t.paymentId} IS NOT NULL AND ${t.amendmentPaymentId} IS NULL) OR (${t.paymentId} IS NULL AND ${t.amendmentPaymentId} IS NOT NULL)`,
    ),
    // G7M-A : BOOKING_MODIFICATION référence le paiement initial.
    check(
      'refunds_booking_modification_payment_id',
      sql`${t.reason} <> 'BOOKING_MODIFICATION' OR ${t.paymentId} IS NOT NULL`,
    ),
    // G7M-A : AMENDMENT_COMPENSATION référence le paiement de supplément.
    check(
      'refunds_amendment_compensation_amendment_payment_id',
      sql`${t.reason} <> 'AMENDMENT_COMPENSATION' OR ${t.amendmentPaymentId} IS NOT NULL`,
    ),
    // G7M-A : LATE_PAYMENT_NO_BOOKING et EXTERNAL_REFUND requièrent payment_id
    // (raisons historiques qui ne peuvent pas référencer un paiement de supplément).
    check(
      'refunds_late_payment_requires_payment_id',
      sql`${t.reason} <> 'LATE_PAYMENT_NO_BOOKING' OR ${t.paymentId} IS NOT NULL`,
    ),
    check(
      'refunds_external_refund_requires_payment_id',
      sql`${t.reason} <> 'EXTERNAL_REFUND' OR ${t.paymentId} IS NOT NULL`,
    ),
    // G7M-A : SETTLED_OFF_PLATFORM requiert les colonnes de résolution.
    check(
      'refunds_settled_off_platform_invariants',
      sql`${t.status} <> 'SETTLED_OFF_PLATFORM' OR (${t.settledOffPlatformAt} IS NOT NULL AND ${t.settledOffPlatformBy} IS NOT NULL)`,
    ),
    index('refunds_status_requested_at_index').on(t.status, t.requestedAt),
  ],
);

export const bookingFulfillmentEvents = pgTable(
  'booking_fulfillment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    eventType: fulfillmentEventType('event_type').notNull(),
    previousStatus: bookingStatus('previous_status').notNull(),
    nextStatus: bookingStatus('next_status').notNull(),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id),
    idempotencyKey: text('idempotency_key').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('booking_fulfillment_events_org_idempotency_key_unique').on(
      t.organizationId,
      t.idempotencyKey,
    ),
    check('booking_fulfillment_events_status_change', sql`${t.previousStatus} <> ${t.nextStatus}`),
    check(
      'booking_fulfillment_events_prepared',
      sql`(${t.eventType} = 'PREPARED' AND ${t.previousStatus} = 'CONFIRMED' AND ${t.nextStatus} = 'READY_FOR_PICKUP') OR ${t.eventType} <> 'PREPARED'`,
    ),
    check(
      'booking_fulfillment_events_picked_up',
      sql`(${t.eventType} = 'PICKED_UP' AND ${t.previousStatus} = 'READY_FOR_PICKUP' AND ${t.nextStatus} = 'ACTIVE') OR ${t.eventType} <> 'PICKED_UP'`,
    ),
    check(
      'booking_fulfillment_events_returned',
      sql`(${t.eventType} = 'RETURNED' AND ${t.previousStatus} = 'ACTIVE' AND ${t.nextStatus} = 'RETURNED') OR ${t.eventType} <> 'RETURNED'`,
    ),
    check(
      'booking_fulfillment_events_closed',
      sql`(${t.eventType} = 'CLOSED' AND ${t.previousStatus} = 'RETURNED' AND ${t.nextStatus} = 'CLOSED') OR ${t.eventType} <> 'CLOSED'`,
    ),
    check(
      'booking_fulfillment_events_idempotency_key_nonempty',
      sql`length(btrim(${t.idempotencyKey})) > 0`,
    ),
    index('booking_fulfillment_events_org_booking_index').on(t.organizationId, t.bookingId),
    index('booking_fulfillment_events_org_occurred_at_index').on(t.organizationId, t.occurredAt),
  ],
);

export const conditionReports = pgTable(
  'condition_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    // G7M-A : booking_item_id devient nullable pour supporter les rapports
    // sur une allocation d'amendement. XOR avec amendment_allocation_id.
    bookingItemId: uuid('booking_item_id').references(() => bookingItems.id),
    amendmentAllocationId: uuid('amendment_allocation_id').references(
      () => bookingAmendmentAllocations.id,
    ),
    inventoryItemId: uuid('inventory_item_id')
      .notNull()
      .references(() => inventoryItems.id),
    phase: conditionReportPhase('phase').notNull(),
    condition: inventoryCondition('condition').notNull(),
    notes: text('notes'),
    reporterUserId: uuid('reporter_user_id')
      .notNull()
      .references(() => users.id),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('condition_reports_org_idempotency_key_unique').on(t.organizationId, t.idempotencyKey),
    check(
      'condition_reports_idempotency_key_nonempty',
      sql`length(btrim(${t.idempotencyKey})) > 0`,
    ),
    // G7M-A : XOR — exactement une référence d'item non-null.
    check(
      'condition_reports_item_origin_xor',
      sql`(${t.bookingItemId} IS NOT NULL AND ${t.amendmentAllocationId} IS NULL) OR (${t.bookingItemId} IS NULL AND ${t.amendmentAllocationId} IS NOT NULL)`,
    ),
    index('condition_reports_org_booking_index').on(t.organizationId, t.bookingId),
    index('condition_reports_org_booking_item_index').on(t.organizationId, t.bookingItemId),
  ],
);

export const damageReports = pgTable(
  'damage_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    // G7M-A : booking_item_id devient nullable pour supporter les rapports
    // sur une allocation d'amendement. XOR avec amendment_allocation_id.
    bookingItemId: uuid('booking_item_id').references(() => bookingItems.id),
    amendmentAllocationId: uuid('amendment_allocation_id').references(
      () => bookingAmendmentAllocations.id,
    ),
    inventoryItemId: uuid('inventory_item_id')
      .notNull()
      .references(() => inventoryItems.id),
    description: text('description').notNull(),
    reporterUserId: uuid('reporter_user_id')
      .notNull()
      .references(() => users.id),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('damage_reports_org_idempotency_key_unique').on(t.organizationId, t.idempotencyKey),
    check('damage_reports_description_nonempty', sql`length(btrim(${t.description})) > 0`),
    check('damage_reports_idempotency_key_nonempty', sql`length(btrim(${t.idempotencyKey})) > 0`),
    // G7M-A : XOR — exactement une référence d'item non-null.
    check(
      'damage_reports_item_origin_xor',
      sql`(${t.bookingItemId} IS NOT NULL AND ${t.amendmentAllocationId} IS NULL) OR (${t.bookingItemId} IS NULL AND ${t.amendmentAllocationId} IS NOT NULL)`,
    ),
    index('damage_reports_org_booking_index').on(t.organizationId, t.bookingId),
    index('damage_reports_org_booking_item_index').on(t.organizationId, t.bookingItemId),
  ],
);

// ---------------------------------------------------------------------------
// Lot 6 G5B — Documents transactionnels (ADR-013).
// Enums et tables pour document_render_snapshots, documents, outbox_effects,
// notification_deliveries. Aucune logique métier : schéma et contrats uniquement.
// ---------------------------------------------------------------------------

export const documentType = pgEnum('document_type', ['CONFIRMATION', 'CONTRACT', 'RECEIPT']);

export const outboxEffectType = pgEnum('outbox_effect_type', [
  'GENERATE_CONFIRMATION',
  'GENERATE_CONTRACT',
  'GENERATE_RECEIPT',
  'SEND_EMAIL',
]);

export const outboxEffectStatus = pgEnum('outbox_effect_status', [
  'PENDING',
  'COMPLETED',
  'FAILED',
]);

export const notificationDeliveryStatus = pgEnum('notification_delivery_status', [
  'PENDING',
  'SENT',
  'FAILED',
  'REQUIRES_MANUAL_REVIEW',
]);

export const documentProcessingFailureCode = pgEnum('document_processing_failure_code', [
  'PAYLOAD_MALFORMED',
  'STORAGE_PUT_FAILED',
  'STORAGE_CHECKSUM_MISMATCH',
  'STORAGE_NOT_FOUND',
  'RENDER_FAILED',
  'EMAIL_SEND_FAILED',
  'LEASE_LOST',
  'UNKNOWN_ERROR',
  'PROVIDER_RESULT_UNCERTAIN',
  'EMAIL_RETRY_WINDOW_EXPIRED',
]);

export const documentRenderSnapshots = pgTable(
  'document_render_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    outboxEventId: uuid('outbox_event_id')
      .notNull()
      .references(() => outboxEvents.id),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    snapshot: jsonb('snapshot').notNull(),
    templateVersion: text('template_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('document_render_snapshots_outbox_event_id_unique').on(t.outboxEventId),
    check(
      'document_render_snapshots_template_version_nonempty',
      sql`length(btrim(${t.templateVersion})) > 0`,
    ),
    check(
      'document_render_snapshots_snapshot_is_object',
      sql`jsonb_typeof(${t.snapshot}) = 'object'`,
    ),
    index('document_render_snapshots_org_outbox_event_index').on(t.organizationId, t.outboxEventId),
  ],
);

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    type: documentType('type').notNull(),
    version: integer('version').notNull(),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').notNull(),
    checksumSha256: text('checksum_sha256').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    templateVersion: text('template_version').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
    sourceOutboxEventId: uuid('source_outbox_event_id')
      .notNull()
      .references(() => outboxEvents.id),
    renderSnapshotId: uuid('render_snapshot_id')
      .notNull()
      .references(() => documentRenderSnapshots.id),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('documents_booking_type_version_unique').on(t.bookingId, t.type, t.version),
    unique('documents_storage_key_unique').on(t.storageKey),
    check('documents_version_positive', sql`${t.version} > 0`),
    check('documents_size_bytes_nonneg', sql`${t.sizeBytes} >= 0`),
    check('documents_size_bytes_max_safe', sql`${t.sizeBytes} <= 9007199254740991`),
    check('documents_checksum_sha256_hex', sql`${t.checksumSha256} ~ '^[0-9a-f]{64}$'`),
    check('documents_content_type_nonempty', sql`length(btrim(${t.contentType})) > 0`),
    check('documents_template_version_nonempty', sql`length(btrim(${t.templateVersion})) > 0`),
    check('documents_storage_key_nonempty', sql`length(btrim(${t.storageKey})) > 0`),
    check('documents_idempotency_key_nonempty', sql`length(btrim(${t.idempotencyKey})) > 0`),
    index('documents_org_booking_index').on(t.organizationId, t.bookingId),
    index('documents_source_outbox_event_index').on(t.sourceOutboxEventId),
  ],
);

export const outboxEffects = pgTable(
  'outbox_effects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    outboxEventId: uuid('outbox_event_id')
      .notNull()
      .references(() => outboxEvents.id),
    effectType: outboxEffectType('effect_type').notNull(),
    status: outboxEffectStatus('status').notNull().default('PENDING'),
    documentId: uuid('document_id').references(() => documents.id),
    storageKey: text('storage_key'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    attemptCount: integer('attempt_count').notNull().default(0),
    failureCode: documentProcessingFailureCode('failure_code'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('outbox_effects_outbox_event_effect_unique').on(t.outboxEventId, t.effectType),
    check(
      'outbox_effects_pending_invariants',
      sql`${t.status} <> 'PENDING' OR (${t.documentId} IS NULL AND ${t.completedAt} IS NULL AND ${t.failureCode} IS NULL)`,
    ),
    check(
      'outbox_effects_completed_invariants',
      sql`${t.status} <> 'COMPLETED' OR (${t.completedAt} IS NOT NULL AND ${t.failureCode} IS NULL)`,
    ),
    check(
      'outbox_effects_failed_invariants',
      sql`${t.status} <> 'FAILED' OR (${t.completedAt} IS NOT NULL AND ${t.failureCode} IS NOT NULL)`,
    ),
    check(
      'outbox_effects_send_email_invariants',
      sql`${t.effectType} <> 'SEND_EMAIL' OR (${t.documentId} IS NULL AND ${t.storageKey} IS NULL)`,
    ),
    check(
      'outbox_effects_generate_completed_invariants',
      sql`${t.effectType} NOT IN ('GENERATE_CONFIRMATION', 'GENERATE_CONTRACT', 'GENERATE_RECEIPT') OR ${t.status} <> 'COMPLETED' OR (${t.documentId} IS NOT NULL AND ${t.storageKey} IS NOT NULL)`,
    ),
    check('outbox_effects_attempt_count_nonneg', sql`${t.attemptCount} >= 0`),
    check('outbox_effects_idempotency_key_nonempty', sql`length(btrim(${t.idempotencyKey})) > 0`),
    check(
      'outbox_effects_storage_key_nonempty',
      sql`${t.storageKey} IS NULL OR length(btrim(${t.storageKey})) > 0`,
    ),
    uniqueIndex('outbox_effects_storage_key_unique_partial')
      .on(t.storageKey)
      .where(sql`${t.storageKey} IS NOT NULL`),
    index('outbox_effects_org_outbox_event_index').on(t.organizationId, t.outboxEventId),
  ],
);

export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    outboxEventId: uuid('outbox_event_id')
      .notNull()
      .references(() => outboxEvents.id),
    outboxEffectId: uuid('outbox_effect_id')
      .notNull()
      .references(() => outboxEffects.id),
    recipientEmail: text('recipient_email').notNull(),
    templateKey: text('template_key').notNull(),
    providerIdempotencyKey: text('provider_idempotency_key').notNull().unique(),
    status: notificationDeliveryStatus('status').notNull().default('PENDING'),
    providerMessageId: text('provider_message_id'),
    failureCode: documentProcessingFailureCode('failure_code'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    providerFirstAttemptStartedAt: timestamp('provider_first_attempt_started_at', {
      withTimezone: true,
    }),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('notification_deliveries_outbox_effect_unique').on(t.outboxEffectId),
    check(
      'notification_deliveries_pending_invariants',
      sql`${t.status} <> 'PENDING' OR (${t.providerMessageId} IS NULL AND ${t.sentAt} IS NULL AND ${t.failureCode} IS NULL)`,
    ),
    check(
      'notification_deliveries_sent_invariants',
      sql`${t.status} <> 'SENT' OR (length(btrim(${t.providerMessageId})) > 0 AND ${t.sentAt} IS NOT NULL AND ${t.failureCode} IS NULL)`,
    ),
    check(
      'notification_deliveries_failed_invariants',
      sql`${t.status} <> 'FAILED' OR (${t.failureCode} IS NOT NULL AND ${t.sentAt} IS NULL)`,
    ),
    check(
      'notification_deliveries_requires_manual_review_invariants',
      sql`${t.status} <> 'REQUIRES_MANUAL_REVIEW' OR (${t.providerMessageId} IS NULL AND ${t.sentAt} IS NULL AND ${t.failureCode} IS NOT NULL AND ${t.failureCode} IN ('PROVIDER_RESULT_UNCERTAIN', 'EMAIL_RETRY_WINDOW_EXPIRED'))`,
    ),
    check(
      'notification_deliveries_recipient_email_nonempty',
      sql`length(btrim(${t.recipientEmail})) > 0`,
    ),
    check(
      'notification_deliveries_template_key_nonempty',
      sql`length(btrim(${t.templateKey})) > 0`,
    ),
    check(
      'notification_deliveries_provider_idempotency_key_nonempty',
      sql`length(btrim(${t.providerIdempotencyKey})) > 0`,
    ),
    check(
      'notification_deliveries_idempotency_key_nonempty',
      sql`length(btrim(${t.idempotencyKey})) > 0`,
    ),
    index('notification_deliveries_org_outbox_event_index').on(t.organizationId, t.outboxEventId),
    index('notification_deliveries_requires_manual_review_index')
      .on(t.status)
      .where(sql`${t.status} = 'REQUIRES_MANUAL_REVIEW'`),
    index('notification_deliveries_provider_first_attempt_index')
      .on(t.providerFirstAttemptStartedAt)
      .where(sql`${t.providerFirstAttemptStartedAt} IS NOT NULL`),
  ],
);

// ---------------------------------------------------------------------------
// Lot 7 G7P-A — Plans tarifaires flexibles (ADR-018, migration 0032)
// ---------------------------------------------------------------------------

/**
 * Plans tarifaires par variante. Chaque ligne représente un plan de type
 * HOURLY, FIXED_DURATION ou DAILY avec une union discriminée stricte :
 * - HOURLY : min/max/billing_duration_minutes > 0, included = NULL
 * - FIXED_DURATION : included_duration_minutes > 0, min/max/billing = NULL
 * - DAILY : tous les champs de durée = NULL
 *
 * Clé métier (business key) — exclut la version :
 *   (product_variant_id, scope default/local, currency, plan_type,
 *    included_duration_minutes pour FIXED_DURATION)
 * Version = numéro de révision de la clé métier (entier > 0).
 *
 * Cycle de vie (lifecycle_state) : DRAFT → ACTIVE → RETIRED (cycle fermé).
 * - DRAFT : plan modifiable librement. Peut être supprimé (hard delete).
 * - ACTIVE : plan immuable (seuls lifecycle_state et updated_at changent).
 * - RETIRED : plan immuable, ne peut plus être activé ni supprimé.
 *
 * Héritage default/local :
 * - location_id NULL = plan par défaut (s'applique à tous les magasins de même
 *   devise).
 * - location_id non NULL = remplacement explicite pour ce magasin (doit utiliser
 *   la devise opérationnelle du magasin).
 *
 * Un plan local remplace intégralement le plan par défaut portant la même clé
 * fonctionnelle (variant, type, durée si applicable, devise). La résolution
 * est indépendante du numéro de version.
 *
 * Traductions FR+EN requises pour l'activation (table pricing_plan_translations).
 * Fenêtres et paliers gelés dans la version (mutations interdits si non-DRAFT).
 */
export const pricingPlans = pgTable(
  'pricing_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    productVariantId: uuid('product_variant_id')
      .notNull()
      .references(() => productVariants.id),
    locationId: uuid('location_id').references(() => locations.id),
    planType: pricingPlanType('plan_type').notNull(),
    currency: text('currency').notNull(),
    priceAmountMinor: bigint('price_amount_minor', { mode: 'number' }).notNull(),
    minDurationMinutes: integer('min_duration_minutes'),
    maxDurationMinutes: integer('max_duration_minutes'),
    billingIncrementMinutes: integer('billing_increment_minutes'),
    includedDurationMinutes: integer('included_duration_minutes'),
    internalLabel: text('internal_label'),
    priority: integer('priority').notNull().default(0),
    lifecycleState: pricingLifecycleState('lifecycle_state').notNull().default('DRAFT'),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('pricing_plans_price_positive', sql`${t.priceAmountMinor} > 0`),
    check('pricing_plans_price_max_safe', sql`${t.priceAmountMinor} <= 9007199254740991`),
    check('pricing_plans_currency_iso', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('pricing_plans_version_positive', sql`${t.version} > 0`),
    // Union discriminée stricte : HOURLY
    check(
      'pricing_plans_hourly_fields',
      sql`(${t.planType} = 'HOURLY' AND ${t.minDurationMinutes} IS NOT NULL AND ${t.minDurationMinutes} > 0 AND ${t.maxDurationMinutes} IS NOT NULL AND ${t.maxDurationMinutes} >= ${t.minDurationMinutes} AND ${t.billingIncrementMinutes} IS NOT NULL AND ${t.billingIncrementMinutes} > 0 AND ${t.includedDurationMinutes} IS NULL) OR (${t.planType} <> 'HOURLY' AND ${t.minDurationMinutes} IS NULL AND ${t.maxDurationMinutes} IS NULL AND ${t.billingIncrementMinutes} IS NULL)`,
    ),
    // Union discriminée stricte : FIXED_DURATION
    check(
      'pricing_plans_fixed_duration_fields',
      sql`(${t.planType} = 'FIXED_DURATION' AND ${t.includedDurationMinutes} IS NOT NULL AND ${t.includedDurationMinutes} > 0 AND ${t.minDurationMinutes} IS NULL AND ${t.maxDurationMinutes} IS NULL AND ${t.billingIncrementMinutes} IS NULL) OR (${t.planType} <> 'FIXED_DURATION' AND ${t.includedDurationMinutes} IS NULL)`,
    ),
    // Union discriminée stricte : DAILY
    check(
      'pricing_plans_daily_fields',
      sql`(${t.planType} = 'DAILY' AND ${t.minDurationMinutes} IS NULL AND ${t.maxDurationMinutes} IS NULL AND ${t.billingIncrementMinutes} IS NULL AND ${t.includedDurationMinutes} IS NULL) OR (${t.planType} <> 'DAILY')`,
    ),
    // Index unique — au plus un plan ACTIVE par clé métier (exclut la version)
    uniqueIndex('pricing_plans_active_business_key_unique')
      .on(
        t.productVariantId,
        sql`COALESCE(${t.locationId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        t.planType,
        t.currency,
        sql`COALESCE(${t.includedDurationMinutes}, -1)`,
      )
      .where(sql`${t.lifecycleState} = 'ACTIVE'`),
    // Index unique — unicité historique de (clé métier, version)
    uniqueIndex('pricing_plans_business_key_version_unique').on(
      t.productVariantId,
      sql`COALESCE(${t.locationId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.planType,
      t.currency,
      sql`COALESCE(${t.includedDurationMinutes}, -1)`,
      t.version,
    ),
    // Index de performance
    index('pricing_plans_variant_active_index')
      .on(t.productVariantId)
      .where(sql`${t.lifecycleState} = 'ACTIVE'`),
    index('pricing_plans_location_index')
      .on(t.locationId)
      .where(sql`${t.locationId} IS NOT NULL`),
  ],
);

/**
 * Fenêtres commerciales d'un plan tarifaire, rattachées à un magasin (pour le
 * fuseau IANA). Permet de modéliser plusieurs plages pour un même plan (ex.
 * demi-journée matin 9 h–13 h, après-midi 13 h–17 h).
 *
 * Décision conservatrice : les forfaits traversant minuit ne sont PAS autorisés
 * (end_time > start_time, pas de wraparound). ADR-018 n'autorise pas
 * explicitement les intervalles traversant minuit.
 */
export const pricingPlanWindows = pgTable(
  'pricing_plan_windows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pricingPlanId: uuid('pricing_plan_id')
      .notNull()
      .references(() => pricingPlans.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id),
    weekdayMask: integer('weekday_mask').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Pas de wraparound minuit (décision conservatrice).
    check('pricing_plan_windows_time_order', sql`${t.endTime} > ${t.startTime}`),
    check(
      'pricing_plan_windows_weekday_mask_range',
      sql`${t.weekdayMask} >= 1 AND ${t.weekdayMask} <= 127`,
    ),
    index('pricing_plan_windows_plan_index').on(t.pricingPlanId),
  ],
);

/**
 * Paliers de réduction multi-jours rattachés à un plan DAILY. Le seuil est en
 * nombre de jours, le pourcentage est strictement supérieur à 0 et strictement
 * inférieur à 100. Un seul palier actif par (plan, seuil).
 *
 * Les paliers d'un plan DAILY local remplacent intégralement ceux du plan
 * DAILY par défaut (pas de fusion implicite).
 */
export const multiDayDiscountTiers = pgTable(
  'multi_day_discount_tiers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pricingPlanId: uuid('pricing_plan_id')
      .notNull()
      .references(() => pricingPlans.id, { onDelete: 'cascade' }),
    thresholdDays: integer('threshold_days').notNull(),
    discountPercent: integer('discount_percent').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('multi_day_discount_tiers_threshold_min', sql`${t.thresholdDays} >= 2`),
    check(
      'multi_day_discount_tiers_discount_range',
      sql`${t.discountPercent} > 0 AND ${t.discountPercent} < 100`,
    ),
    uniqueIndex('multi_day_discount_tiers_plan_threshold_unique')
      .on(t.pricingPlanId, t.thresholdDays)
      .where(sql`${t.active} = true`),
    index('multi_day_discount_tiers_plan_active_index')
      .on(t.pricingPlanId)
      .where(sql`${t.active} = true`),
  ],
);

/**
 * Traductions des libellés publics des plans tarifaires par locale.
 * Un plan doit posséder au moins les traductions 'fr' et 'en' pour pouvoir
 * être activé (passer à ACTIVE). Les traductions sont gelées (INSERT/UPDATE/
 * DELETE interdits) quand le plan est ACTIVE ou RETIRED.
 */
export const pricingPlanTranslations = pgTable(
  'pricing_plan_translations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pricingPlanId: uuid('pricing_plan_id')
      .notNull()
      .references(() => pricingPlans.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    publicLabel: text('public_label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('pricing_plan_translations_plan_locale_unique').on(t.pricingPlanId, t.locale),
    check('pricing_plan_translations_locale_format', sql`${t.locale} ~ '^[a-z]{2}(-[A-Z]{2})?$'`),
    check('pricing_plan_translations_label_not_empty', sql`length(btrim(${t.publicLabel})) > 0`),
    index('pricing_plan_translations_plan_locale_index').on(t.pricingPlanId, t.locale),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// G7F-A2 — Photos produit et gate de publication (ADR-020, migration 0034).
// ─────────────────────────────────────────────────────────────────────────────

export const productPhotoFileState = pgEnum('product_photo_file_state', [
  'PENDING_UPLOAD',
  'AVAILABLE',
  'REJECTED',
  'DELETED',
]);

export const productPhotoSlotType = pgEnum('product_photo_slot_type', [
  'HERO_PROFILE',
  'THREE_QUARTER_FRONT',
  'SECONDARY_VIEW',
  'THREE_QUARTER',
  'SIGNATURE_DETAIL',
  'FULL_BIKE',
  'DRIVETRAIN',
  'BRAKES_TIRES',
  'BATTERY',
  'MOTOR',
  'DISPLAY',
  'CHARGER',
]);

export const productPhotos = pgTable(
  'product_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Identifiant exposable dans les URLs publiques. L'ID primaire reste
    // réservé aux requêtes internes et aux contrôles d'appartenance.
    publicId: uuid('public_id').notNull().unique().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    productId: uuid('product_id').notNull(),
    // NOTE : FK composite (product_id, organization_id) → products(id, organization_id)
    // non représentée ici car Drizzle ne supporte pas facilement les FK composites.
    // La FK composite est créée dans la migration SQL 0034 et garantit la cohérence
    // multi-tenant au niveau PostgreSQL, même par SQL direct.
    storageKey: text('storage_key').notNull(),
    slotType: productPhotoSlotType('slot_type'),
    contentType: text('content_type'),
    byteSize: bigint('byte_size', { mode: 'number' }),
    widthPx: integer('width_px'),
    heightPx: integer('height_px'),
    checksumSha256: text('checksum_sha256'),
    sortOrder: integer('sort_order').notNull().default(0),
    fileState: productPhotoFileState('file_state').notNull(),
    rejectionReason: text('rejection_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // Invariant d'état exhaustif : nullabilité selon file_state.
    check(
      'product_photos_state_invariants',
      sql`CASE
        WHEN ${t.fileState} = 'PENDING_UPLOAD' THEN
          ${t.deletedAt} IS NULL AND ${t.rejectionReason} IS NULL
        WHEN ${t.fileState} = 'AVAILABLE' THEN
          ${t.contentType} IS NOT NULL AND ${t.byteSize} IS NOT NULL
          AND ${t.widthPx} IS NOT NULL AND ${t.heightPx} IS NOT NULL
          AND ${t.checksumSha256} IS NOT NULL
          AND ${t.deletedAt} IS NULL AND ${t.rejectionReason} IS NULL
        WHEN ${t.fileState} = 'REJECTED' THEN
          ${t.rejectionReason} IS NOT NULL AND ${t.deletedAt} IS NULL
        WHEN ${t.fileState} = 'DELETED' THEN
          ${t.deletedAt} IS NOT NULL
        ELSE FALSE
      END`,
    ),
    check(
      'product_photos_content_type_valid',
      sql`${t.contentType} IS NULL OR ${t.contentType} IN ('image/jpeg', 'image/png', 'image/webp')`,
    ),
    check(
      'product_photos_byte_size_valid',
      sql`${t.byteSize} IS NULL OR (${t.byteSize} > 0 AND ${t.byteSize} <= 10485760)`,
    ),
    check(
      'product_photos_dimensions_valid',
      sql`(${t.widthPx} IS NULL OR (${t.widthPx} >= 200 AND ${t.widthPx} <= 8000))
           AND (${t.heightPx} IS NULL OR (${t.heightPx} >= 200 AND ${t.heightPx} <= 8000))`,
    ),
    check('product_photos_sort_order_non_negative', sql`${t.sortOrder} >= 0`),
    check('product_photos_storage_key_not_empty', sql`length(${t.storageKey}) > 0`),
    check('product_photos_storage_key_prefix', sql`${t.storageKey} ~ '^product-photos/'`),
    check(
      'product_photos_checksum_format',
      sql`${t.checksumSha256} IS NULL OR ${t.checksumSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'product_photos_rejection_reason_not_empty',
      sql`${t.rejectionReason} IS NULL OR btrim(${t.rejectionReason}) <> ''`,
    ),
    index('product_photos_product_id_deleted_at_idx').on(t.productId, t.deletedAt),
    index('product_photos_organization_id_deleted_at_idx').on(t.organizationId, t.deletedAt),
    index('product_photos_product_id_file_state_deleted_at_idx').on(
      t.productId,
      t.fileState,
      t.deletedAt,
    ),
    uniqueIndex('product_photos_storage_key_unique').on(t.storageKey),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type Country = typeof countries.$inferSelect;
export type NewCountry = typeof countries.$inferInsert;
export type Destination = typeof destinations.$inferSelect;
export type NewDestination = typeof destinations.$inferInsert;
export type DestinationTranslation = typeof destinationTranslations.$inferSelect;
export type NewDestinationTranslation = typeof destinationTranslations.$inferInsert;
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
export type BookingFulfillmentEvent = typeof bookingFulfillmentEvents.$inferSelect;
export type NewBookingFulfillmentEvent = typeof bookingFulfillmentEvents.$inferInsert;
export type ConditionReport = typeof conditionReports.$inferSelect;
export type NewConditionReport = typeof conditionReports.$inferInsert;
export type DamageReport = typeof damageReports.$inferSelect;
export type NewDamageReport = typeof damageReports.$inferInsert;
export type DocumentRenderSnapshot = typeof documentRenderSnapshots.$inferSelect;
export type NewDocumentRenderSnapshot = typeof documentRenderSnapshots.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type OutboxEffect = typeof outboxEffects.$inferSelect;
export type NewOutboxEffect = typeof outboxEffects.$inferInsert;
export type NotificationDelivery = typeof notificationDeliveries.$inferSelect;
export type NewNotificationDelivery = typeof notificationDeliveries.$inferInsert;
export type PricingPlan = typeof pricingPlans.$inferSelect;
export type NewPricingPlan = typeof pricingPlans.$inferInsert;
export type PricingPlanWindow = typeof pricingPlanWindows.$inferSelect;
export type NewPricingPlanWindow = typeof pricingPlanWindows.$inferInsert;
export type MultiDayDiscountTier = typeof multiDayDiscountTiers.$inferSelect;
export type NewMultiDayDiscountTier = typeof multiDayDiscountTiers.$inferInsert;
export type PricingPlanTranslation = typeof pricingPlanTranslations.$inferSelect;
export type NewPricingPlanTranslation = typeof pricingPlanTranslations.$inferInsert;
export type ProductPhotoRecord = typeof productPhotos.$inferSelect;
export type NewProductPhotoRecord = typeof productPhotos.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// G7H-A — Fondations analytics first-party privacy-first (ADR-022, migration 0035).
// ─────────────────────────────────────────────────────────────────────────────

export const analyticsEventType = pgEnum('analytics_event_type', [
  'PUBLIC_SEARCH_PERFORMED',
  'BOOKING_ATTEMPTED',
  'BOOKING_CONFIRMED',
]);

export const analyticsEnvironment = pgEnum('analytics_environment', [
  'DEVELOPMENT',
  'TEST',
  'PRODUCTION',
]);

export const productAnalyticsEvents = pgTable(
  'product_analytics_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventType: analyticsEventType('event_type').notNull(),
    environment: analyticsEnvironment('environment').notNull(),
    sourceId: uuid('source_id').notNull(),
    hasResults: boolean('has_results'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('product_analytics_events_dedup_unique').on(t.eventType, t.environment, t.sourceId),
    check(
      'product_analytics_events_has_results_invariants',
      sql`CASE
        WHEN ${t.eventType} = 'PUBLIC_SEARCH_PERFORMED' THEN ${t.hasResults} IS NOT NULL
        WHEN ${t.eventType} IN ('BOOKING_ATTEMPTED', 'BOOKING_CONFIRMED') THEN ${t.hasResults} IS NULL
        ELSE FALSE
      END`,
    ),
    index('product_analytics_events_env_occurred_type_idx').on(
      t.environment,
      t.occurredAt,
      t.eventType,
    ),
  ],
);

export const productAnalyticsDaily = pgTable(
  'product_analytics_daily',
  {
    day: date('day').notNull(),
    environment: analyticsEnvironment('environment').notNull(),
    searches: bigint('searches', { mode: 'bigint' }).notNull(),
    searchesWithResults: bigint('searches_with_results', { mode: 'bigint' }).notNull(),
    bookingAttempts: bigint('booking_attempts', { mode: 'bigint' }).notNull(),
    bookingsConfirmed: bigint('bookings_confirmed', { mode: 'bigint' }).notNull(),
    compactedSearches: bigint('compacted_searches', { mode: 'bigint' }).notNull().default(0n),
    compactedSearchesWithResults: bigint('compacted_searches_with_results', {
      mode: 'bigint',
    })
      .notNull()
      .default(0n),
    compactedBookingAttempts: bigint('compacted_booking_attempts', { mode: 'bigint' })
      .notNull()
      .default(0n),
    compactedBookingsConfirmed: bigint('compacted_bookings_confirmed', { mode: 'bigint' })
      .notNull()
      .default(0n),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'product_analytics_daily_pkey', columns: [t.day, t.environment] }),
    check('product_analytics_daily_searches_non_negative', sql`${t.searches} >= 0`),
    check(
      'product_analytics_daily_searches_with_results_non_negative',
      sql`${t.searchesWithResults} >= 0`,
    ),
    check('product_analytics_daily_booking_attempts_non_negative', sql`${t.bookingAttempts} >= 0`),
    check(
      'product_analytics_daily_bookings_confirmed_non_negative',
      sql`${t.bookingsConfirmed} >= 0`,
    ),
    check(
      'product_analytics_daily_searches_with_results_le_searches',
      sql`${t.searchesWithResults} <= ${t.searches}`,
    ),
    check('product_analytics_daily_compacted_s_nn', sql`${t.compactedSearches} >= 0`),
    check('product_analytics_daily_compacted_swr_nn', sql`${t.compactedSearchesWithResults} >= 0`),
    check('product_analytics_daily_compacted_ba_nn', sql`${t.compactedBookingAttempts} >= 0`),
    check('product_analytics_daily_compacted_bc_nn', sql`${t.compactedBookingsConfirmed} >= 0`),
    check('product_analytics_daily_compacted_s_le_s', sql`${t.compactedSearches} <= ${t.searches}`),
    check(
      'product_analytics_daily_compacted_swr_le_swr',
      sql`${t.compactedSearchesWithResults} <= ${t.searchesWithResults}`,
    ),
    check(
      'product_analytics_daily_compacted_ba_le_ba',
      sql`${t.compactedBookingAttempts} <= ${t.bookingAttempts}`,
    ),
    check(
      'product_analytics_daily_compacted_bc_le_bc',
      sql`${t.compactedBookingsConfirmed} <= ${t.bookingsConfirmed}`,
    ),
    check(
      'product_analytics_daily_compacted_swr_le_cs',
      sql`${t.compactedSearchesWithResults} <= ${t.compactedSearches}`,
    ),
  ],
);

export type ProductAnalyticsEvent = typeof productAnalyticsEvents.$inferSelect;
export type NewProductAnalyticsEvent = typeof productAnalyticsEvents.$inferInsert;
export type ProductAnalyticsDaily = typeof productAnalyticsDaily.$inferSelect;
export type NewProductAnalyticsDaily = typeof productAnalyticsDaily.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// G7M-A — Fondations PostgreSQL append-only des amendements financiers (ADR-023,
// migration 0036). Schéma, triggers et contraintes uniquement. Aucun flux
// métier, Stripe, webhook, worker, API ou UI.
// ─────────────────────────────────────────────────────────────────────────────

export const amendmentType = pgEnum('amendment_type', ['NEUTRAL', 'SUPPLEMENT', 'REFUND']);

export const amendmentStatus = pgEnum('amendment_status', [
  'HOLD_PENDING',
  'READY_TO_APPLY',
  'APPLIED',
  'EXPIRED',
  'CANCELLED',
  'FAILED',
]);

export const amendmentLineOriginType = pgEnum('amendment_line_origin_type', [
  'ORIGINAL',
  'AMENDMENT',
]);

export const amendmentLineAction = pgEnum('amendment_line_action', [
  'ADD',
  'MODIFY',
  'REMOVE',
  'UNCHANGED',
]);

export const amendmentAllocationAction = pgEnum('amendment_allocation_action', [
  'RETAIN',
  'ADD',
  'REMOVE',
  'REPLACE',
]);

export const amendmentAllocationStatus = pgEnum('amendment_allocation_status', [
  'PROPOSED',
  'CONVERTED',
  'RELEASED',
  'EXPIRED',
]);

export const amendmentSegmentStatus = pgEnum('amendment_segment_status', [
  'PROPOSED',
  'CONVERTED',
  'RELEASED',
  'EXPIRED',
]);

export const amendmentPaymentStatus = pgEnum('amendment_payment_status', [
  'PENDING_PROVIDER',
  'REQUIRES_PAYMENT_METHOD',
  'REQUIRES_ACTION',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);

export const amendmentPaymentAttemptStatus = pgEnum('amendment_payment_attempt_status', [
  'PENDING_PROVIDER',
  'REQUIRES_PAYMENT_METHOD',
  'REQUIRES_ACTION',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);

export const bookingAmendments = pgTable(
  'booking_amendments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    amendmentNumber: integer('amendment_number').notNull(),
    type: amendmentType('type').notNull(),
    status: amendmentStatus('status').notNull().default('HOLD_PENDING'),
    financialSnapshotBefore: jsonb('financial_snapshot_before').notNull(),
    financialSnapshotAfter: jsonb('financial_snapshot_after').notNull(),
    newCustomerStartAt: timestamp('new_customer_start_at', { withTimezone: true }).notNull(),
    newCustomerEndAt: timestamp('new_customer_end_at', { withTimezone: true }).notNull(),
    newBlockedStartAt: timestamp('new_blocked_start_at', { withTimezone: true }).notNull(),
    newBlockedEndAt: timestamp('new_blocked_end_at', { withTimezone: true }).notNull(),
    holdDeadline: timestamp('hold_deadline', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
  },
  (t) => [
    unique('booking_amendments_booking_number_unique').on(t.bookingId, t.amendmentNumber),
    check('booking_amendments_number_positive', sql`${t.amendmentNumber} > 0`),
    check(
      'booking_amendments_customer_period_valid',
      sql`${t.newCustomerEndAt} > ${t.newCustomerStartAt}`,
    ),
    check(
      'booking_amendments_blocked_includes_customer',
      sql`${t.newBlockedStartAt} <= ${t.newCustomerStartAt} AND ${t.newBlockedEndAt} >= ${t.newCustomerEndAt}`,
    ),
    // hold_deadline obligatoire uniquement pour SUPPLEMENT en état actif.
    check(
      'booking_amendments_supplement_hold_deadline',
      sql`${t.type} <> 'SUPPLEMENT' OR ${t.holdDeadline} IS NOT NULL`,
    ),
    // hold_deadline interdit pour NEUTRAL et REFUND.
    check(
      'booking_amendments_non_supplement_no_hold_deadline',
      sql`${t.type} = 'SUPPLEMENT' OR ${t.holdDeadline} IS NULL`,
    ),
    // APPLIED requiert appliedAt.
    check(
      'booking_amendments_applied_has_timestamp',
      sql`${t.status} <> 'APPLIED' OR ${t.appliedAt} IS NOT NULL`,
    ),
    // EXPIRED requiert expiredAt.
    check(
      'booking_amendments_expired_has_timestamp',
      sql`${t.status} <> 'EXPIRED' OR ${t.expiredAt} IS NOT NULL`,
    ),
    // CANCELLED requiert cancelledAt.
    check(
      'booking_amendments_cancelled_has_timestamp',
      sql`${t.status} <> 'CANCELLED' OR ${t.cancelledAt} IS NOT NULL`,
    ),
    // FAILED requiert failedAt.
    check(
      'booking_amendments_failed_has_timestamp',
      sql`${t.status} <> 'FAILED' OR ${t.failedAt} IS NOT NULL`,
    ),
    // Un seul amendement actif par booking (index partiel).
    uniqueIndex('booking_amendments_single_active_per_booking')
      .on(t.bookingId)
      .where(sql`${t.status} IN ('HOLD_PENDING', 'READY_TO_APPLY')`),
    index('booking_amendments_organization_booking_status_index').on(
      t.organizationId,
      t.bookingId,
      t.status,
    ),
  ],
);

export const bookingAmendmentLines = pgTable(
  'booking_amendment_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    amendmentId: uuid('amendment_id')
      .notNull()
      .references(() => bookingAmendments.id),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    logicalLineId: uuid('logical_line_id').notNull(),
    originType: amendmentLineOriginType('origin_type').notNull(),
    sourceBookingLineId: uuid('source_booking_line_id').references(() => bookingLines.id),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id),
    action: amendmentLineAction('action').notNull(),
    beforeQuantity: integer('before_quantity').notNull(),
    beforeUnitPriceAmountMinor: bigint('before_unit_price_amount_minor', {
      mode: 'number',
    }).notNull(),
    beforeLineTotalAmountMinor: bigint('before_line_total_amount_minor', {
      mode: 'number',
    }).notNull(),
    afterQuantity: integer('after_quantity').notNull(),
    afterUnitPriceAmountMinor: bigint('after_unit_price_amount_minor', {
      mode: 'number',
    }).notNull(),
    afterLineTotalAmountMinor: bigint('after_line_total_amount_minor', {
      mode: 'number',
    }).notNull(),
    pricingSnapshot: jsonb('pricing_snapshot').notNull(),
    variantSnapshot: jsonb('variant_snapshot').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('booking_amendment_lines_amendment_logical_line_unique').on(
      t.amendmentId,
      t.logicalLineId,
    ),
    unique('booking_amendment_lines_amendment_variant_unique').on(t.amendmentId, t.variantId),
    // ORIGINAL requiert source_booking_line_id ; AMENDMENT l'interdit.
    check(
      'booking_amendment_lines_original_has_source',
      sql`${t.originType} <> 'ORIGINAL' OR ${t.sourceBookingLineId} IS NOT NULL`,
    ),
    check(
      'booking_amendment_lines_amendment_no_source',
      sql`${t.originType} <> 'AMENDMENT' OR ${t.sourceBookingLineId} IS NULL`,
    ),
    // ADD : before = 0, after > 0.
    check(
      'booking_amendment_lines_add_before_zero_after_positive',
      sql`${t.action} <> 'ADD' OR (${t.beforeQuantity} = 0 AND ${t.afterQuantity} > 0)`,
    ),
    // MODIFY : before > 0, after > 0.
    check(
      'booking_amendment_lines_modify_before_after_positive',
      sql`${t.action} <> 'MODIFY' OR (${t.beforeQuantity} > 0 AND ${t.afterQuantity} > 0)`,
    ),
    // REMOVE : before > 0, after = 0.
    check(
      'booking_amendment_lines_remove_before_positive_after_zero',
      sql`${t.action} <> 'REMOVE' OR (${t.beforeQuantity} > 0 AND ${t.afterQuantity} = 0)`,
    ),
    // UNCHANGED : before et after identiques.
    check(
      'booking_amendment_lines_unchanged_before_after_equal',
      sql`${t.action} <> 'UNCHANGED' OR (${t.beforeQuantity} = ${t.afterQuantity} AND ${t.beforeUnitPriceAmountMinor} = ${t.afterUnitPriceAmountMinor} AND ${t.beforeLineTotalAmountMinor} = ${t.afterLineTotalAmountMinor})`,
    ),
    // Montants non-négatifs et safe integer.
    check('booking_amendment_lines_before_qty_nonneg', sql`${t.beforeQuantity} >= 0`),
    check('booking_amendment_lines_after_qty_nonneg', sql`${t.afterQuantity} >= 0`),
    check(
      'booking_amendment_lines_before_unit_price_nonneg',
      sql`${t.beforeUnitPriceAmountMinor} >= 0`,
    ),
    check(
      'booking_amendment_lines_after_unit_price_nonneg',
      sql`${t.afterUnitPriceAmountMinor} >= 0`,
    ),
    check(
      'booking_amendment_lines_before_line_total_nonneg',
      sql`${t.beforeLineTotalAmountMinor} >= 0`,
    ),
    check(
      'booking_amendment_lines_after_line_total_nonneg',
      sql`${t.afterLineTotalAmountMinor} >= 0`,
    ),
    check(
      'booking_amendment_lines_before_line_total_max_safe',
      sql`${t.beforeLineTotalAmountMinor} <= 9007199254740991`,
    ),
    check(
      'booking_amendment_lines_after_line_total_max_safe',
      sql`${t.afterLineTotalAmountMinor} <= 9007199254740991`,
    ),
    check(
      'booking_amendment_lines_before_unit_price_max_safe',
      sql`${t.beforeUnitPriceAmountMinor} <= 9007199254740991`,
    ),
    check(
      'booking_amendment_lines_after_unit_price_max_safe',
      sql`${t.afterUnitPriceAmountMinor} <= 9007199254740991`,
    ),
    index('booking_amendment_lines_amendment_id_index').on(t.amendmentId),
    index('booking_amendment_lines_org_amendment_index').on(t.organizationId, t.amendmentId),
  ],
);

export const bookingAmendmentAllocations = pgTable(
  'booking_amendment_allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    amendmentId: uuid('amendment_id')
      .notNull()
      .references(() => bookingAmendments.id),
    amendmentLineId: uuid('amendment_line_id')
      .notNull()
      .references(() => bookingAmendmentLines.id),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    inventoryItemId: uuid('inventory_item_id')
      .notNull()
      .references(() => inventoryItems.id),
    action: amendmentAllocationAction('action').notNull(),
    sourceBookingBlockId: uuid('source_booking_block_id').references(() => inventoryBlocks.id),
    appliedBookingBlockId: uuid('applied_booking_block_id').references(() => inventoryBlocks.id),
    status: amendmentAllocationStatus('status').notNull().default('PROPOSED'),
    effectiveCustomerStartAt: timestamp('effective_customer_start_at', {
      withTimezone: true,
    }).notNull(),
    effectiveCustomerEndAt: timestamp('effective_customer_end_at', {
      withTimezone: true,
    }).notNull(),
    effectiveBlockedStartAt: timestamp('effective_blocked_start_at', {
      withTimezone: true,
    }).notNull(),
    effectiveBlockedEndAt: timestamp('effective_blocked_end_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('booking_amendment_allocations_amendment_item_unique').on(
      t.amendmentId,
      t.inventoryItemId,
    ),
    check(
      'booking_amendment_allocations_customer_period_valid',
      sql`${t.effectiveCustomerEndAt} > ${t.effectiveCustomerStartAt}`,
    ),
    check(
      'booking_amendment_allocations_blocked_includes_customer',
      sql`${t.effectiveBlockedStartAt} <= ${t.effectiveCustomerStartAt} AND ${t.effectiveBlockedEndAt} >= ${t.effectiveCustomerEndAt}`,
    ),
    // RETAIN et REPLACE requièrent source_booking_block_id ; ADD l'interdit.
    check(
      'booking_amendment_allocations_retain_has_source',
      sql`${t.action} <> 'RETAIN' OR ${t.sourceBookingBlockId} IS NOT NULL`,
    ),
    check(
      'booking_amendment_allocations_replace_has_source',
      sql`${t.action} <> 'REPLACE' OR ${t.sourceBookingBlockId} IS NOT NULL`,
    ),
    check(
      'booking_amendment_allocations_add_no_source',
      sql`${t.action} <> 'ADD' OR ${t.sourceBookingBlockId} IS NULL`,
    ),
    // REMOVE interdit applied_booking_block_id.
    check(
      'booking_amendment_allocations_remove_no_applied_block',
      sql`${t.action} <> 'REMOVE' OR ${t.appliedBookingBlockId} IS NULL`,
    ),
    // applied_booking_block_id non-null uniquement si CONVERTED.
    check(
      'booking_amendment_allocations_applied_block_converted_only',
      sql`${t.appliedBookingBlockId} IS NULL OR ${t.status} = 'CONVERTED'`,
    ),
    index('booking_amendment_allocations_amendment_id_index').on(t.amendmentId),
    index('booking_amendment_allocations_org_amendment_index').on(t.organizationId, t.amendmentId),
  ],
);

export const bookingAmendmentSegments = pgTable(
  'booking_amendment_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    allocationId: uuid('allocation_id')
      .notNull()
      .references(() => bookingAmendmentAllocations.id),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    inventoryItemId: uuid('inventory_item_id')
      .notNull()
      .references(() => inventoryItems.id),
    holdBlockId: uuid('hold_block_id')
      .notNull()
      .unique()
      .references(() => inventoryBlocks.id),
    deltaStartAt: timestamp('delta_start_at', { withTimezone: true }).notNull(),
    deltaEndAt: timestamp('delta_end_at', { withTimezone: true }).notNull(),
    status: amendmentSegmentStatus('status').notNull().default('PROPOSED'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'booking_amendment_segments_delta_period_valid',
      sql`${t.deltaEndAt} > ${t.deltaStartAt}`,
    ),
    index('booking_amendment_segments_allocation_id_index').on(t.allocationId),
    index('booking_amendment_segments_org_allocation_index').on(t.organizationId, t.allocationId),
  ],
);

export const amendmentPayments = pgTable(
  'amendment_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    amendmentId: uuid('amendment_id')
      .notNull()
      .unique()
      .references(() => bookingAmendments.id),
    customerUserId: uuid('customer_user_id')
      .notNull()
      .references(() => users.id),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('EUR'),
    environment: paymentEnvironment('environment').notNull(),
    // G7M-A corrections : colonnes de snapshot Stripe minimales pour l'appel
    // Stripe futur et la réconciliation (sous-ensemble de la table payments).
    connectedAccountId: text('connected_account_id').notNull(),
    onBehalfOfAccountId: text('on_behalf_of_account_id'),
    chargeModel: chargeModel('charge_model').notNull(),
    settlementMerchantMode: settlementMerchantMode('settlement_merchant_mode').notNull(),
    processingStartedAt: timestamp('processing_started_at', { withTimezone: true }),
    processingDeadlineAt: timestamp('processing_deadline_at', { withTimezone: true }),
    status: amendmentPaymentStatus('status').notNull().default('PENDING_PROVIDER'),
    succeededAt: timestamp('succeeded_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('amendment_payments_currency_eur', sql`${t.currency} = 'EUR'`),
    check('amendment_payments_amount_positive', sql`${t.amountMinor} > 0`),
    check('amendment_payments_amount_max_safe', sql`${t.amountMinor} <= 9007199254740991`),
    check(
      'amendment_payments_succeeded_has_timestamp',
      sql`${t.status} <> 'SUCCEEDED' OR ${t.succeededAt} IS NOT NULL`,
    ),
    check(
      'amendment_payments_failed_has_timestamp',
      sql`${t.status} <> 'FAILED' OR ${t.failedAt} IS NOT NULL`,
    ),
    check(
      'amendment_payments_cancelled_has_timestamp',
      sql`${t.status} <> 'CANCELLED' OR ${t.cancelledAt} IS NOT NULL`,
    ),
    check('amendment_payments_environment_check', sql`${t.environment} IN ('TEST', 'LIVE')`),
    index('amendment_payments_organization_status_index').on(t.organizationId, t.status),
    index('amendment_payments_booking_id_index').on(t.bookingId),
  ],
);

export const amendmentPaymentAttempts = pgTable(
  'amendment_payment_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    amendmentPaymentId: uuid('amendment_payment_id')
      .notNull()
      .references(() => amendmentPayments.id),
    attemptNumber: integer('attempt_number').notNull(),
    status: amendmentPaymentAttemptStatus('status').notNull(),
    providerPaymentIntentId: text('provider_payment_intent_id').unique(),
    providerStatus: text('provider_status'),
    providerIdempotencyKey: text('provider_idempotency_key').notNull().unique(),
    lastProviderErrorCode: text('last_provider_error_code'),
    reconcileAfter: timestamp('reconcile_after', { withTimezone: true }),
    reconcileLeaseUntil: timestamp('reconcile_lease_until', { withTimezone: true }),
    reconcileLeaseToken: uuid('reconcile_lease_token'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('amendment_payment_attempts_payment_attempt_number_unique').on(
      t.amendmentPaymentId,
      t.attemptNumber,
    ),
    check('amendment_payment_attempts_attempt_number_positive', sql`${t.attemptNumber} > 0`),
    check(
      'amendment_payment_attempts_idempotency_key_nonempty',
      sql`length(btrim(${t.providerIdempotencyKey})) > 0`,
    ),
    check(
      'amendment_payment_attempts_provider_status_with_intent',
      sql`${t.providerPaymentIntentId} IS NULL OR ${t.providerStatus} IS NOT NULL`,
    ),
    check(
      'amendment_payment_attempts_lease_token_lease_until_consistent',
      sql`(${t.reconcileLeaseToken} IS NULL AND ${t.reconcileLeaseUntil} IS NULL) OR (${t.reconcileLeaseToken} IS NOT NULL AND ${t.reconcileLeaseUntil} IS NOT NULL)`,
    ),
    // Un seul attempt non-terminal par amendment_payment.
    uniqueIndex('amendment_payment_attempts_single_non_terminal_attempt')
      .on(t.amendmentPaymentId)
      .where(
        sql`${t.status} IN ('PENDING_PROVIDER', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING')`,
      ),
    index('amendment_payment_attempts_payment_id_status_index').on(t.amendmentPaymentId, t.status),
    index('amendment_payment_attempts_reconcile_index')
      .on(t.status, t.reconcileAfter, t.reconcileLeaseUntil)
      .where(
        sql`${t.status} IN ('PENDING_PROVIDER', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING')`,
      ),
  ],
);

export type BookingAmendment = typeof bookingAmendments.$inferSelect;
export type NewBookingAmendment = typeof bookingAmendments.$inferInsert;
export type BookingAmendmentLine = typeof bookingAmendmentLines.$inferSelect;
export type NewBookingAmendmentLine = typeof bookingAmendmentLines.$inferInsert;
export type BookingAmendmentAllocation = typeof bookingAmendmentAllocations.$inferSelect;
export type NewBookingAmendmentAllocation = typeof bookingAmendmentAllocations.$inferInsert;
export type BookingAmendmentSegment = typeof bookingAmendmentSegments.$inferSelect;
export type NewBookingAmendmentSegment = typeof bookingAmendmentSegments.$inferInsert;
export type AmendmentPayment = typeof amendmentPayments.$inferSelect;
export type NewAmendmentPayment = typeof amendmentPayments.$inferInsert;
export type AmendmentPaymentAttempt = typeof amendmentPaymentAttempts.$inferSelect;
export type NewAmendmentPaymentAttempt = typeof amendmentPaymentAttempts.$inferInsert;

// Chantier 9.1 — Domaine Maintenance & Atelier persistant
export const maintenanceCaseStatus = pgEnum('maintenance_case_status', [
  'OPEN',
  'IN_PROGRESS',
  'RESOLVED',
]);

export const maintenanceCases = pgTable(
  'maintenance_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    inventoryItemId: uuid('inventory_item_id')
      .notNull()
      .references(() => inventoryItems.id),
    maintenanceBlockId: uuid('maintenance_block_id')
      .notNull()
      .references(() => inventoryBlocks.id),
    sourceDamageReportId: uuid('source_damage_report_id').references(() => damageReports.id),
    status: maintenanceCaseStatus('status').notNull().default('OPEN'),
    reason: text('reason').notNull(),
    openedNotes: text('opened_notes'),
    openedBy: uuid('opened_by')
      .notNull()
      .references(() => users.id),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    startedBy: uuid('started_by').references(() => users.id),
    startedAt: timestamp('started_at', { withTimezone: true }),
    resolutionNotes: text('resolution_notes'),
    resolvedBy: uuid('resolved_by').references(() => users.id),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('maintenance_cases_org_status_index').on(t.organizationId, t.status),
    index('maintenance_cases_item_index').on(t.inventoryItemId),
    index('maintenance_cases_block_index').on(t.maintenanceBlockId),
  ],
);

export type MaintenanceCase = typeof maintenanceCases.$inferSelect;
export type NewMaintenanceCase = typeof maintenanceCases.$inferInsert;

// Chantier 11 — Revenus & Versements (Projection locale des versements Stripe)
export const connectedAccountPayoutStatus = pgEnum('connected_account_payout_status', [
  'PENDING',
  'IN_TRANSIT',
  'PAID',
  'FAILED',
  'CANCELLED',
]);

export const connectedAccountPayouts = pgTable(
  'connected_account_payouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    provider: paymentProvider('provider').notNull().default('STRIPE'),
    environment: paymentEnvironment('environment').notNull(),
    providerPayoutId: text('provider_payout_id').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('EUR'),
    status: connectedAccountPayoutStatus('status').notNull(),
    arrivalDate: timestamp('arrival_date', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    providerCreatedAt: bigint('provider_created_at', { mode: 'number' }),
    lastProviderEventAt: timestamp('last_provider_event_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    unique('connected_account_payouts_provider_payout_unique').on(
      t.provider,
      t.environment,
      t.providerPayoutId,
    ),
    index('connected_account_payouts_org_status_index').on(t.organizationId, t.status),
    index('connected_account_payouts_org_arrival_index').on(t.organizationId, t.arrivalDate),
  ],
);

export type ConnectedAccountPayout = typeof connectedAccountPayouts.$inferSelect;
export type NewConnectedAccountPayout = typeof connectedAccountPayouts.$inferInsert;

export const bookingCancellations = pgTable(
  'booking_cancellations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    bookingId: uuid('booking_id')
      .notNull()
      .unique()
      .references(() => bookings.id),
    cancelledByUserId: uuid('cancelled_by_user_id')
      .notNull()
      .references(() => users.id),
    actorReason: cancellationActorReason('actor_reason').notNull(),
    policyCode: text('policy_code').notNull(),
    policySnapshot: jsonb('policy_snapshot').notNull(),
    grossPaidMinor: bigint('gross_paid_minor', { mode: 'number' }).notNull(),
    refundAmountMinor: bigint('refund_amount_minor', { mode: 'number' }).notNull(),
    retainedAmountMinor: bigint('retained_amount_minor', { mode: 'number' }).notNull(),
    originalCommissionMinor: bigint('original_commission_minor', { mode: 'number' }).notNull(),
    commissionRefundedMinor: bigint('commission_refunded_minor', { mode: 'number' }).notNull(),
    finalCommissionMinor: bigint('final_commission_minor', { mode: 'number' }).notNull(),
    finalMerchantRevenueMinor: bigint('final_merchant_revenue_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('EUR'),
    explanationCode: text('explanation_code').notNull(),
    inventoryReleased: boolean('inventory_released').notNull().default(true),
    refundId: uuid('refund_id').references(() => refunds.id),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('booking_cancellations_org_idx').on(t.organizationId),
    index('booking_cancellations_booking_idx').on(t.bookingId),
    index('booking_cancellations_occurred_at_idx').on(t.occurredAt),
    check('booking_cancellations_currency_eur', sql`${t.currency} = 'EUR'`),
    check('booking_cancellations_gross_paid_non_negative', sql`${t.grossPaidMinor} >= 0`),
    check('booking_cancellations_refund_non_negative', sql`${t.refundAmountMinor} >= 0`),
    check('booking_cancellations_retained_non_negative', sql`${t.retainedAmountMinor} >= 0`),
  ],
);

export type BookingCancellation = typeof bookingCancellations.$inferSelect;
export type NewBookingCancellation = typeof bookingCancellations.$inferInsert;
