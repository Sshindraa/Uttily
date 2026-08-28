import { describe, it, expect } from 'vitest';
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
} from './enums';

describe('client-safe enums', () => {
  it('contient les statuts de réservation complets', () => {
    expect(BOOKING_STATUSES).toContain('CONFIRMED');
    expect(BOOKING_STATUSES).toContain('READY_FOR_PICKUP');
    expect(BOOKING_STATUSES).toContain('ACTIVE');
    expect(BOOKING_STATUSES).toContain('RETURNED');
    expect(BOOKING_STATUSES).toContain('CLOSED');
    expect(BOOKING_STATUSES).toContain('CANCELLED');
    expect(BOOKING_STATUSES).toContain('REFUNDED');
    expect(BOOKING_STATUSES).toHaveLength(7);
  });

  it('contient les états matériels', () => {
    expect(INVENTORY_CONDITIONS).toEqual(['NEW', 'GOOD', 'FAIR', 'POOR', 'BROKEN']);
  });

  it('contient les événements de fulfillment', () => {
    expect(FULFILLMENT_EVENT_TYPES).toEqual(['PREPARED', 'PICKED_UP', 'RETURNED', 'CLOSED']);
  });

  it('contient les phases de rapport d état', () => {
    expect(CONDITION_REPORT_PHASES).toEqual(['PICKUP', 'RETURN']);
  });

  it('contient les statuts d inventaire', () => {
    expect(INVENTORY_STATUSES).toEqual(['ACTIVE', 'RETIRED', 'LOST']);
  });

  it('contient les types et statuts de blocages', () => {
    expect(INVENTORY_BLOCK_TYPES).toEqual(['HOLD', 'BOOKING', 'MAINTENANCE', 'MANUAL_BLOCK']);
    expect(INVENTORY_BLOCK_STATUSES).toEqual([
      'ACTIVE',
      'PAYMENT_PROCESSING',
      'CONVERTED',
      'RELEASED',
      'EXPIRED',
    ]);
  });

  it('contient les statuts de publication produit', () => {
    expect(PRODUCT_PUBLICATION_STATUSES).toEqual(['DRAFT', 'PUBLISHED', 'ARCHIVED']);
  });

  it('contient les rôles de membres', () => {
    expect(MEMBERSHIP_ROLES).toEqual(['OWNER', 'ADMIN', 'MANAGER', 'STAFF']);
    expect(MEMBERSHIP_STATUSES).toEqual(['ACTIVE', 'SUSPENDED', 'REMOVED']);
  });

  it('contient les statuts de paiement et remboursement', () => {
    expect(PAYMENT_STATUSES).toContain('SUCCEEDED');
    expect(REFUND_STATUSES).toContain('SUCCEEDED');
  });

  it('contient les types de plans tarifaires', () => {
    expect(PRICING_PLAN_TYPES).toEqual(['HOURLY', 'FIXED_DURATION', 'DAILY']);
  });
});
