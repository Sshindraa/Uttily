import { describe, expect, it } from 'vitest';
import {
  BOOKING_STATUSES,
  type BookingStatus,
  type InventoryCondition,
  type ConditionReportPhase,
  type FulfillmentEventType,
} from '@uttily/core';
import {
  bookingStatusLabel,
  buildFilterUrl,
  canCreateDamageReport,
  canCreatePickupReport,
  canCreateReturnReport,
  conditionLabel,
  eventTypeLabel,
  formatDateTimeInTimeZone,
  getTransitionAction,
  isReadOnlyStatus,
  isValidUuid,
  parseStatusFilter,
  phaseLabel,
  QUICK_FILTERS,
} from './operations-helpers';

// Statuts terminaux (lecture seule) et non-terminaux pour les tests structurels.
const TERMINAL_STATUSES: readonly BookingStatus[] = ['CLOSED', 'CANCELLED', 'REFUNDED'];
const NON_TERMINAL_STATUSES: readonly BookingStatus[] = [
  'CONFIRMED',
  'READY_FOR_PICKUP',
  'ACTIVE',
  'RETURNED',
];

describe('operations-helpers', () => {
  describe('bookingStatusLabel', () => {
    it.each(BOOKING_STATUSES as readonly BookingStatus[])(
      'retourne un libellé français non vide pour %s',
      (status) => {
        const label = bookingStatusLabel(status);
        expect(typeof label).toBe('string');
        expect(label.length).toBeGreaterThan(0);
      },
    );

    it('CONFIRMED → Confirmée', () => {
      expect(bookingStatusLabel('CONFIRMED')).toBe('Confirmée');
    });

    it('READY_FOR_PICKUP → Prête au retrait', () => {
      expect(bookingStatusLabel('READY_FOR_PICKUP')).toBe('Prête au retrait');
    });

    it('ACTIVE → En cours', () => {
      expect(bookingStatusLabel('ACTIVE')).toBe('En cours');
    });

    it('RETURNED → À réceptionner', () => {
      expect(bookingStatusLabel('RETURNED')).toBe('À réceptionner');
    });

    it('CLOSED → Clôturée', () => {
      expect(bookingStatusLabel('CLOSED')).toBe('Clôturée');
    });

    it('CANCELLED → Annulée', () => {
      expect(bookingStatusLabel('CANCELLED')).toBe('Annulée');
    });

    it('REFUNDED → Remboursée', () => {
      expect(bookingStatusLabel('REFUNDED')).toBe('Remboursée');
    });
  });

  describe('getTransitionAction', () => {
    it('CONFIRMED → action de préparation', () => {
      const action = getTransitionAction('CONFIRMED');
      expect(action).not.toBeNull();
      expect(action?.kind).toBe('prepare');
      expect(action?.label).toBe('Marquer comme préparée');
      expect(action?.helpText.length).toBeGreaterThan(0);
    });

    it('READY_FOR_PICKUP → action de remise (label contient "remise")', () => {
      const action = getTransitionAction('READY_FOR_PICKUP');
      expect(action?.kind).toBe('pickup');
      expect(action?.label.toLowerCase()).toContain('remise');
    });

    it('ACTIVE → action de réception (label contient "réception")', () => {
      const action = getTransitionAction('ACTIVE');
      expect(action?.kind).toBe('return');
      expect(action?.label.toLowerCase()).toContain('réception');
    });

    it('RETURNED → action de clôture (label contient "Clôturer")', () => {
      const action = getTransitionAction('RETURNED');
      expect(action?.kind).toBe('close');
      expect(action?.label).toContain('Clôturer');
    });

    it('CLOSED → null', () => {
      expect(getTransitionAction('CLOSED')).toBeNull();
    });

    it('CANCELLED → null', () => {
      expect(getTransitionAction('CANCELLED')).toBeNull();
    });

    it('REFUNDED → null', () => {
      expect(getTransitionAction('REFUNDED')).toBeNull();
    });
  });

  describe('canCreatePickupReport', () => {
    it('CONFIRMED → false', () => {
      expect(canCreatePickupReport('CONFIRMED')).toBe(false);
    });

    it('READY_FOR_PICKUP → true', () => {
      expect(canCreatePickupReport('READY_FOR_PICKUP')).toBe(true);
    });

    it('ACTIVE → false', () => {
      expect(canCreatePickupReport('ACTIVE')).toBe(false);
    });

    it('RETURNED → false', () => {
      expect(canCreatePickupReport('RETURNED')).toBe(false);
    });

    it('CLOSED → false', () => {
      expect(canCreatePickupReport('CLOSED')).toBe(false);
    });

    it('CANCELLED → false', () => {
      expect(canCreatePickupReport('CANCELLED')).toBe(false);
    });

    it('REFUNDED → false', () => {
      expect(canCreatePickupReport('REFUNDED')).toBe(false);
    });
  });

  describe('canCreateReturnReport', () => {
    it('CONFIRMED → false', () => {
      expect(canCreateReturnReport('CONFIRMED')).toBe(false);
    });

    it('READY_FOR_PICKUP → false', () => {
      expect(canCreateReturnReport('READY_FOR_PICKUP')).toBe(false);
    });

    it('ACTIVE → true', () => {
      expect(canCreateReturnReport('ACTIVE')).toBe(true);
    });

    it('RETURNED → false', () => {
      expect(canCreateReturnReport('RETURNED')).toBe(false);
    });

    it('CLOSED → false', () => {
      expect(canCreateReturnReport('CLOSED')).toBe(false);
    });

    it('CANCELLED → false', () => {
      expect(canCreateReturnReport('CANCELLED')).toBe(false);
    });

    it('REFUNDED → false', () => {
      expect(canCreateReturnReport('REFUNDED')).toBe(false);
    });
  });

  describe('canCreateDamageReport', () => {
    it('CONFIRMED → false', () => {
      expect(canCreateDamageReport('CONFIRMED')).toBe(false);
    });

    it('READY_FOR_PICKUP → false', () => {
      expect(canCreateDamageReport('READY_FOR_PICKUP')).toBe(false);
    });

    it('ACTIVE → true', () => {
      expect(canCreateDamageReport('ACTIVE')).toBe(true);
    });

    it('RETURNED → true', () => {
      expect(canCreateDamageReport('RETURNED')).toBe(true);
    });

    it('CLOSED → false', () => {
      expect(canCreateDamageReport('CLOSED')).toBe(false);
    });

    it('CANCELLED → false', () => {
      expect(canCreateDamageReport('CANCELLED')).toBe(false);
    });

    it('REFUNDED → false', () => {
      expect(canCreateDamageReport('REFUNDED')).toBe(false);
    });
  });

  describe('isReadOnlyStatus', () => {
    it('CONFIRMED → false', () => {
      expect(isReadOnlyStatus('CONFIRMED')).toBe(false);
    });

    it('READY_FOR_PICKUP → false', () => {
      expect(isReadOnlyStatus('READY_FOR_PICKUP')).toBe(false);
    });

    it('ACTIVE → false', () => {
      expect(isReadOnlyStatus('ACTIVE')).toBe(false);
    });

    it('RETURNED → false', () => {
      expect(isReadOnlyStatus('RETURNED')).toBe(false);
    });

    it('CLOSED → true', () => {
      expect(isReadOnlyStatus('CLOSED')).toBe(true);
    });

    it('CANCELLED → true', () => {
      expect(isReadOnlyStatus('CANCELLED')).toBe(true);
    });

    it('REFUNDED → true', () => {
      expect(isReadOnlyStatus('REFUNDED')).toBe(true);
    });
  });

  describe('QUICK_FILTERS', () => {
    it('contient au moins 6 filtres', () => {
      expect(QUICK_FILTERS.length).toBeGreaterThanOrEqual(6);
    });

    it("le filtre 'all' contient tous les BOOKING_STATUSES", () => {
      const allFilter = QUICK_FILTERS.find((f) => f.key === 'all');
      expect(allFilter).toBeDefined();
      expect(allFilter?.statuses).toEqual(BOOKING_STATUSES);
    });

    it('chaque filtre a un label non vide et des statuts valides', () => {
      for (const filter of QUICK_FILTERS) {
        expect(filter.label.length).toBeGreaterThan(0);
        for (const status of filter.statuses) {
          expect(BOOKING_STATUSES).toContain(status);
        }
      }
    });
  });

  describe('parseStatusFilter', () => {
    it('undefined → null (aucun filtre)', () => {
      expect(parseStatusFilter(undefined)).toBeNull();
    });

    it("'' → null", () => {
      expect(parseStatusFilter('')).toBeNull();
    });

    it("'CONFIRMED' → ['CONFIRMED']", () => {
      expect(parseStatusFilter('CONFIRMED')).toEqual(['CONFIRMED']);
    });

    it("['CONFIRMED', 'ACTIVE'] → ['CONFIRMED', 'ACTIVE']", () => {
      expect(parseStatusFilter(['CONFIRMED', 'ACTIVE'])).toEqual(['CONFIRMED', 'ACTIVE']);
    });

    it("['CONFIRMED', 'CONFIRMED'] → ['CONFIRMED'] (déduplication)", () => {
      expect(parseStatusFilter(['CONFIRMED', 'CONFIRMED'])).toEqual(['CONFIRMED']);
    });

    it("'INVALID_STATUS' → lève une erreur contenant 'invalide'", () => {
      expect(() => parseStatusFilter('INVALID_STATUS')).toThrow(/invalide/i);
    });

    it("['CLOSED', 'CANCELLED', 'REFUNDED'] → ['CLOSED', 'CANCELLED', 'REFUNDED'] (filtre Clôturées)", () => {
      const result = parseStatusFilter(['CLOSED', 'CANCELLED', 'REFUNDED']);
      expect(result).not.toBeNull();
      expect(result!.sort()).toEqual(['CLOSED', 'CANCELLED', 'REFUNDED'].sort());
    });

    it("'CLOSED,CANCELLED,REFUNDED' (virgules) → lève une erreur (pas un statut valide)", () => {
      expect(() => parseStatusFilter('CLOSED,CANCELLED,REFUNDED')).toThrow(/invalide/i);
    });

    it("['CONFIRMED', 'INVALID_STATUS'] → lève une erreur (valeur mixte)", () => {
      expect(() => parseStatusFilter(['CONFIRMED', 'INVALID_STATUS'])).toThrow(/invalide/i);
    });
  });

  describe('buildFilterUrl', () => {
    it("filtre 'all' → URL sans query string", () => {
      const allFilter = QUICK_FILTERS.find((f) => f.key === 'all')!;
      expect(buildFilterUrl('00000000-0000-0000-0000-000000000001', allFilter)).toBe(
        '/dashboard/00000000-0000-0000-0000-000000000001/bookings',
      );
    });

    it("filtre mono-statut 'to_prepare' → ?status=CONFIRMED", () => {
      const filter = QUICK_FILTERS.find((f) => f.key === 'to_prepare')!;
      expect(buildFilterUrl('00000000-0000-0000-0000-000000000001', filter)).toBe(
        '/dashboard/00000000-0000-0000-0000-000000000001/bookings?status=CONFIRMED',
      );
    });

    it("filtre 'closed' → paramètres répétés (pas de virgules)", () => {
      const filter = QUICK_FILTERS.find((f) => f.key === 'closed')!;
      const url = buildFilterUrl('00000000-0000-0000-0000-000000000001', filter);
      expect(url).toContain('status=CLOSED');
      expect(url).toContain('status=CANCELLED');
      expect(url).toContain('status=REFUNDED');
      expect(url).not.toContain('CLOSED,CANCELLED');
      expect(url).not.toContain('CANCELLED,REFUNDED');
    });
  });

  describe('round-trip QUICK_FILTERS → URL → parseStatusFilter', () => {
    // Simule le parsing Next.js des paramètres répétés.
    // Next.js 16 parse ?status=A&status=B en ['A', 'B'].
    function parseUrlStatuses(url: string): string | string[] | undefined {
      const qIndex = url.indexOf('?');
      if (qIndex === -1) return undefined;
      const params = new URLSearchParams(url.slice(qIndex + 1));
      const statuses = params.getAll('status');
      if (statuses.length === 0) return undefined;
      if (statuses.length === 1) return statuses[0]!;
      return statuses;
    }

    it.each(QUICK_FILTERS)('round-trip exact pour le filtre %s', (filter) => {
      const url = buildFilterUrl('00000000-0000-0000-0000-000000000001', filter);
      const parsed = parseUrlStatuses(url);
      const result = parseStatusFilter(parsed);
      if (filter.key === 'all') {
        // 'all' → pas de query string → null (aucun filtre)
        expect(result).toBeNull();
      } else {
        expect(result).not.toBeNull();
        expect(result!.sort()).toEqual([...filter.statuses].sort());
      }
    });
  });

  describe('formatDateTimeInTimeZone', () => {
    const fixedDate = new Date('2026-03-15T10:00:00Z');

    it("fuseau 'Europe/Paris' → chaîne française contenant le jour", () => {
      const result = formatDateTimeInTimeZone(fixedDate, 'Europe/Paris');
      expect(result).toContain('15');
    });

    it("fuseau 'America/New_York' → chaîne différente de Europe/Paris", () => {
      const paris = formatDateTimeInTimeZone(fixedDate, 'Europe/Paris');
      const ny = formatDateTimeInTimeZone(fixedDate, 'America/New_York');
      expect(ny).not.toEqual(paris);
    });

    it('fuseau invalide → fallback (ne lance pas)', () => {
      expect(() => formatDateTimeInTimeZone(fixedDate, 'Invalid/Fuseau')).not.toThrow();
    });

    it('contient le jour 15 pour une date déterministe', () => {
      const result = formatDateTimeInTimeZone(fixedDate, 'Europe/Paris');
      expect(result).toContain('15');
    });
  });

  describe('isValidUuid', () => {
    it('UUID valide → true', () => {
      expect(isValidUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });

    it("UUID invalide ('not-a-uuid') → false", () => {
      expect(isValidUuid('not-a-uuid')).toBe(false);
    });

    it('UUID avec mauvaise longueur → false', () => {
      expect(isValidUuid('550e8400-e29b-41d4-a716-44665544000')).toBe(false);
    });

    it('chaîne vide → false', () => {
      expect(isValidUuid('')).toBe(false);
    });
  });

  describe('conditionLabel', () => {
    it("NEW → 'Neuf'", () => {
      expect(conditionLabel('NEW')).toBe('Neuf');
    });

    it("GOOD → 'Bon'", () => {
      expect(conditionLabel('GOOD')).toBe('Bon');
    });

    it("FAIR → 'Correct'", () => {
      expect(conditionLabel('FAIR')).toBe('Correct');
    });

    it("POOR → 'Médiocre'", () => {
      expect(conditionLabel('POOR')).toBe('Médiocre');
    });

    it("BROKEN → 'Cassé'", () => {
      expect(conditionLabel('BROKEN')).toBe('Cassé');
    });
  });

  describe('phaseLabel', () => {
    it("PICKUP → 'Retrait'", () => {
      expect(phaseLabel('PICKUP')).toBe('Retrait');
    });

    it("RETURN → 'Retour'", () => {
      expect(phaseLabel('RETURN')).toBe('Retour');
    });
  });

  describe('eventTypeLabel', () => {
    it("PREPARED → 'Préparation'", () => {
      expect(eventTypeLabel('PREPARED')).toBe('Préparation');
    });

    it("PICKED_UP → 'Retrait'", () => {
      expect(eventTypeLabel('PICKED_UP')).toBe('Retrait');
    });

    it("RETURNED → 'Retour'", () => {
      expect(eventTypeLabel('RETURNED')).toBe('Retour');
    });

    it("CLOSED → 'Clôture'", () => {
      expect(eventTypeLabel('CLOSED')).toBe('Clôture');
    });
  });

  describe('exhaustivité structurelle', () => {
    it('bookingStatusLabel : aucun statut ne retourne sa valeur brute', () => {
      for (const status of BOOKING_STATUSES as readonly BookingStatus[]) {
        expect(bookingStatusLabel(status)).not.toBe(status);
      }
    });

    it('getTransitionAction : 4 statuts non-terminaux retournent une action, 3 terminaux retournent null', () => {
      for (const status of NON_TERMINAL_STATUSES) {
        expect(getTransitionAction(status)).not.toBeNull();
      }
      for (const status of TERMINAL_STATUSES) {
        expect(getTransitionAction(status)).toBeNull();
      }
    });
  });

  describe('exhaustivité des libellés', () => {
    it('conditionLabel : chaque InventoryCondition retourne un libellé différent de la valeur brute', () => {
      const conditions: readonly InventoryCondition[] = ['NEW', 'GOOD', 'FAIR', 'POOR', 'BROKEN'];
      for (const c of conditions) {
        expect(conditionLabel(c)).not.toBe(c);
      }
    });

    it('phaseLabel : chaque ConditionReportPhase retourne un libellé différent de la valeur brute', () => {
      const phases: readonly ConditionReportPhase[] = ['PICKUP', 'RETURN'];
      for (const p of phases) {
        expect(phaseLabel(p)).not.toBe(p);
      }
    });

    it('eventTypeLabel : chaque FulfillmentEventType retourne un libellé différent de la valeur brute', () => {
      const types: readonly FulfillmentEventType[] = [
        'PREPARED',
        'PICKED_UP',
        'RETURNED',
        'CLOSED',
      ];
      for (const t of types) {
        expect(eventTypeLabel(t)).not.toBe(t);
      }
    });
  });
});
