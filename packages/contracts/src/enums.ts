/**
 * @uttily/contracts — Enums client-safe partagés (Chantier 17).
 *
 * Ces constantes et types représentent les valeurs métier fermées sans
 * dépendance à drizzle-orm, pg, ou PostgreSQL.
 *
 * Un test de non-dérive (packages/core/src/schema-contracts/enum-drift.test.ts)
 * garantit que ces listes restent strictement synchronisées avec les
 * `.enumValues` de `packages/database/src/schema.ts`.
 */

export const BOOKING_STATUSES = [
  'CONFIRMED',
  'READY_FOR_PICKUP',
  'ACTIVE',
  'RETURNED',
  'CLOSED',
  'CANCELLED',
  'REFUNDED',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const INVENTORY_CONDITIONS = ['NEW', 'GOOD', 'FAIR', 'POOR', 'BROKEN'] as const;
export type InventoryCondition = (typeof INVENTORY_CONDITIONS)[number];

export const FULFILLMENT_EVENT_TYPES = ['PREPARED', 'PICKED_UP', 'RETURNED', 'CLOSED'] as const;
export type FulfillmentEventType = (typeof FULFILLMENT_EVENT_TYPES)[number];

export const CONDITION_REPORT_PHASES = ['PICKUP', 'RETURN'] as const;
export type ConditionReportPhase = (typeof CONDITION_REPORT_PHASES)[number];

export const INVENTORY_STATUSES = ['ACTIVE', 'RETIRED', 'LOST'] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

export const INVENTORY_BLOCK_TYPES = ['HOLD', 'BOOKING', 'MAINTENANCE', 'MANUAL_BLOCK'] as const;
export type InventoryBlockType = (typeof INVENTORY_BLOCK_TYPES)[number];

export const INVENTORY_BLOCK_STATUSES = [
  'ACTIVE',
  'PAYMENT_PROCESSING',
  'CONVERTED',
  'RELEASED',
  'EXPIRED',
] as const;
export type InventoryBlockStatus = (typeof INVENTORY_BLOCK_STATUSES)[number];

export const PRODUCT_PUBLICATION_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type ProductPublicationStatus = (typeof PRODUCT_PUBLICATION_STATUSES)[number];

export const MEMBERSHIP_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'STAFF'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const MEMBERSHIP_STATUSES = ['ACTIVE', 'SUSPENDED', 'REMOVED'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const PAYMENT_STATUSES = [
  'PENDING_PROVIDER',
  'REQUIRES_PAYMENT_METHOD',
  'REQUIRES_ACTION',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const REFUND_STATUSES = [
  'PENDING',
  'SUBMITTED',
  'SUCCEEDED',
  'FAILED',
  'FAILED_REQUIRES_MANUAL_ACTION',
  'SETTLED_OFF_PLATFORM',
] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const PRICING_PLAN_TYPES = ['HOURLY', 'FIXED_DURATION', 'DAILY'] as const;
export type PricingPlanType = (typeof PRICING_PLAN_TYPES)[number];
