import { describe, it, expect } from 'vitest';
import {
  getBookingStatusPresentation,
  getInventoryConditionPresentation,
  getInventoryStatusPresentation,
  getBikeStatusSummaryPresentation,
  getPaymentStatusPresentation,
  getRefundStatusPresentation,
  formatMoneyAmount,
  formatHumanDate,
  getPricingPlanTypeLabel,
  getPricingPlanUnitLabel,
} from './status-presentation';
import {
  BOOKING_STATUSES,
  INVENTORY_CONDITIONS,
  INVENTORY_STATUSES,
  PAYMENT_STATUSES,
  REFUND_STATUSES,
} from '@uttily/contracts';

describe('status-presentation', () => {
  it('fournit une présentation valide pour chaque BookingStatus', () => {
    for (const status of BOOKING_STATUSES) {
      const desc = getBookingStatusPresentation(status);
      expect(desc.label).toBeDefined();
      expect(desc.label.length).toBeGreaterThan(0);
      expect(desc.badgeStyle.backgroundColor).toBeDefined();
      expect(desc.badgeStyle.color).toBeDefined();
    }
  });

  it('fournit une présentation valide pour chaque InventoryCondition', () => {
    for (const condition of INVENTORY_CONDITIONS) {
      const desc = getInventoryConditionPresentation(condition);
      expect(desc.label).toBeDefined();
      expect(desc.label.length).toBeGreaterThan(0);
    }
  });

  it('fournit une présentation valide pour chaque InventoryStatus', () => {
    for (const status of INVENTORY_STATUSES) {
      const desc = getInventoryStatusPresentation(status);
      expect(desc.label).toBeDefined();
      expect(desc.label.length).toBeGreaterThan(0);
    }
    const brokenDesc = getInventoryStatusPresentation('ACTIVE', true);
    expect(brokenDesc.label).toBe('En maintenance');
  });

  it('fournit une présentation valide pour chaque statut de publication vélo', () => {
    const statuses = [
      'ONLINE_AVAILABLE',
      'ONLINE_UNAVAILABLE',
      'READY_TO_PUBLISH',
      'INCOMPLETE',
      'ARCHIVED',
    ] as const;
    for (const s of statuses) {
      const desc = getBikeStatusSummaryPresentation(s);
      expect(desc.label).toBeDefined();
      expect(desc.label.length).toBeGreaterThan(0);
    }
  });

  it('fournit une présentation valide pour PaymentStatus et RefundStatus', () => {
    for (const status of PAYMENT_STATUSES) {
      const desc = getPaymentStatusPresentation(status);
      expect(desc.label).toBeDefined();
    }
    for (const status of REFUND_STATUSES) {
      const desc = getRefundStatusPresentation(status);
      expect(desc.label).toBeDefined();
    }
  });

  it('formate correctement les montants monétaires en centimes', () => {
    expect(formatMoneyAmount(2500)).toContain('25');
    expect(formatMoneyAmount(0)).toContain('0');
    expect(formatMoneyAmount(1999)).toContain('19,99');
  });

  it('formate correctement les dates humaines avec fuseau', () => {
    const testDate = new Date('2026-06-15T14:30:00Z');
    const result = formatHumanDate(testDate, 'Europe/Paris');
    expect(result).toContain('15');
    expect(result).toContain('juin');
    expect(result).toContain('2026');
  });

  it('présente chaque type de plan avec son unité réelle', () => {
    expect(getPricingPlanTypeLabel('DAILY')).toBe('Tarif journalier');
    expect(getPricingPlanUnitLabel('DAILY')).toBe('/ jour');
    expect(getPricingPlanTypeLabel('HOURLY')).toBe('Tarif horaire');
    expect(getPricingPlanUnitLabel('HOURLY')).toBe('/ heure');
    expect(getPricingPlanTypeLabel('FIXED_DURATION')).toBe('Forfait durée fixe');
    expect(getPricingPlanUnitLabel('FIXED_DURATION')).toBe('/ forfait');
  });
});
