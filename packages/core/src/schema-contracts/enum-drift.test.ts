import { describe, it, expect } from 'vitest';
import {
  bookingStatus,
  inventoryCondition,
  fulfillmentEventType,
  conditionReportPhase,
  inventoryStatus,
  inventoryBlockType,
  inventoryBlockStatus,
  productPublicationStatus,
  membershipRole,
  membershipStatus,
  paymentStatus,
  refundStatus,
  pricingPlanType,
} from '@uttily/database';
import {
  BOOKING_STATUSES,
  INVENTORY_CONDITIONS,
  FULFILLMENT_EVENT_TYPES,
  CONDITION_REPORT_PHASES,
  INVENTORY_STATUSES,
  INVENTORY_BLOCK_TYPES,
  INVENTORY_BLOCK_STATUSES,
  PRODUCT_PUBLICATION_STATUSES,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
  PAYMENT_STATUSES,
  REFUND_STATUSES,
  PRICING_PLAN_TYPES,
} from '@uttily/contracts';

/**
 * Test de non-dérive des contrats client-safe (Chantier 17).
 *
 * Garantit que les types et listes partagés dans `@uttily/contracts` (utilisables
 * côté client sans dépendance à Drizzle ni à la DB) correspondent strictement
 * aux `enumValues` déclarés dans le schéma PostgreSQL autoritaire de `@uttily/database`.
 */
describe('Non-dérive des enums entre @uttily/database et @uttily/contracts', () => {
  it('bookingStatus correspond exactement à BOOKING_STATUSES', () => {
    expect([...BOOKING_STATUSES]).toEqual([...bookingStatus.enumValues]);
  });

  it('inventoryCondition correspond exactement à INVENTORY_CONDITIONS', () => {
    expect([...INVENTORY_CONDITIONS]).toEqual([...inventoryCondition.enumValues]);
  });

  it('fulfillmentEventType correspond exactement à FULFILLMENT_EVENT_TYPES', () => {
    expect([...FULFILLMENT_EVENT_TYPES]).toEqual([...fulfillmentEventType.enumValues]);
  });

  it('conditionReportPhase correspond exactement à CONDITION_REPORT_PHASES', () => {
    expect([...CONDITION_REPORT_PHASES]).toEqual([...conditionReportPhase.enumValues]);
  });

  it('inventoryStatus correspond exactement à INVENTORY_STATUSES', () => {
    expect([...INVENTORY_STATUSES]).toEqual([...inventoryStatus.enumValues]);
  });

  it('inventoryBlockType correspond exactement à INVENTORY_BLOCK_TYPES', () => {
    expect([...INVENTORY_BLOCK_TYPES]).toEqual([...inventoryBlockType.enumValues]);
  });

  it('inventoryBlockStatus correspond exactement à INVENTORY_BLOCK_STATUSES', () => {
    expect([...INVENTORY_BLOCK_STATUSES]).toEqual([...inventoryBlockStatus.enumValues]);
  });

  it('productPublicationStatus correspond exactement à PRODUCT_PUBLICATION_STATUSES', () => {
    expect([...PRODUCT_PUBLICATION_STATUSES]).toEqual([...productPublicationStatus.enumValues]);
  });

  it('membershipRole correspond exactement à MEMBERSHIP_ROLES', () => {
    expect([...MEMBERSHIP_ROLES]).toEqual([...membershipRole.enumValues]);
  });

  it('membershipStatus correspond exactement à MEMBERSHIP_STATUSES', () => {
    expect([...MEMBERSHIP_STATUSES]).toEqual([...membershipStatus.enumValues]);
  });

  it('paymentStatus correspond exactement à PAYMENT_STATUSES', () => {
    expect([...PAYMENT_STATUSES]).toEqual([...paymentStatus.enumValues]);
  });

  it('refundStatus correspond exactement à REFUND_STATUSES', () => {
    expect([...REFUND_STATUSES]).toEqual([...refundStatus.enumValues]);
  });

  it('pricingPlanType correspond exactement à PRICING_PLAN_TYPES', () => {
    expect([...PRICING_PLAN_TYPES]).toEqual([...pricingPlanType.enumValues]);
  });
});
