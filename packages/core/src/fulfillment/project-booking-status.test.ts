import { describe, it, expect } from 'vitest';
import { bookingStatus } from '@uttily/database';
import { projectBookingStatus } from './project-booking-status';
import { BookingTransitionError } from './errors';
import { BOOKING_STATUSES, type BookingStatus } from './types';

// ---------------------------------------------------------------------------
// Source de vérité : bookingStatus.enumValues (enum Drizzle du schéma DB).
// Les listes ci-dessous sont indépendantes de l'implémentation et servent de
// vérification croisée. Si un statut est ajouté dans le schéma sans mettre à
// jour la machine, le typecheck échoue (ALLOWED_TRANSITIONS incomplet) et le
// test de garde de dérive échoue aussi.
// ---------------------------------------------------------------------------

const ALL_STATUSES = BOOKING_STATUSES;

/** Transitions autorisées par l'ADR-011 (hardcodées, indépendantes de l'impl). */
const ALLOWED_TRANSITIONS: ReadonlyArray<readonly [BookingStatus, BookingStatus]> = [
  ['CONFIRMED', 'READY_FOR_PICKUP'],
  ['READY_FOR_PICKUP', 'ACTIVE'],
  ['ACTIVE', 'RETURNED'],
  ['RETURNED', 'CLOSED'],
  ['CONFIRMED', 'CANCELLED'],
  ['CONFIRMED', 'REFUNDED'],
];

/** États terminaux : aucune transition sortante (hardcodé, indépendant de l'impl). */
const TERMINAL_STATES: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  'CLOSED',
  'CANCELLED',
  'REFUNDED',
]);

type ExpectedOutcome = 'NOOP' | 'APPLIED' | 'TERMINAL_STATE' | 'INVALID_TRANSITION';

function expectedOutcome(from: BookingStatus, to: BookingStatus): ExpectedOutcome {
  if (from === to) return 'NOOP';
  if (ALLOWED_TRANSITIONS.some(([f, t]) => f === from && t === to)) return 'APPLIED';
  if (TERMINAL_STATES.has(from)) return 'TERMINAL_STATE';
  return 'INVALID_TRANSITION';
}

describe('projectBookingStatus', () => {
  // -------------------------------------------------------------------------
  // Garde de dérive : BOOKING_STATUSES doit correspondre à bookingStatus.enumValues.
  // -------------------------------------------------------------------------
  describe("garde de dérive avec l'enum DB", () => {
    it('BOOKING_STATUSES correspond exactement à bookingStatus.enumValues', () => {
      expect([...BOOKING_STATUSES]).toEqual([...bookingStatus.enumValues]);
    });

    it('BOOKING_STATUSES contient exactement 7 statuts', () => {
      expect(BOOKING_STATUSES.length).toBe(7);
    });
  });

  // -------------------------------------------------------------------------
  // Matrice exhaustive des 49 couples (7 statuts × 7 statuts).
  // -------------------------------------------------------------------------
  describe('matrice exhaustive des 49 couples', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const expected = expectedOutcome(from, to);
        it(`${from} → ${to} → ${expected}`, () => {
          if (expected === 'NOOP') {
            expect(projectBookingStatus(from, to)).toEqual({
              kind: 'NOOP',
              currentStatus: from,
            });
          } else if (expected === 'APPLIED') {
            expect(projectBookingStatus(from, to)).toEqual({
              kind: 'APPLIED',
              previousStatus: from,
              nextStatus: to,
            });
          } else {
            expect(() => projectBookingStatus(from, to)).toThrow(BookingTransitionError);
            try {
              projectBookingStatus(from, to);
            } catch (err) {
              const e = err as BookingTransitionError;
              expect(e.code).toBe(expected);
              expect(e.fromStatus).toBe(from);
              expect(e.toStatus).toBe(to);
            }
          }
        });
      }
    }
  });

  // -------------------------------------------------------------------------
  // Tests descriptifs pour les transitions autorisées (lisibilité humaine).
  // -------------------------------------------------------------------------
  describe('transitions autorisées → APPLIED', () => {
    for (const [from, to] of ALLOWED_TRANSITIONS) {
      it(`${from} → ${to} → APPLIED`, () => {
        expect(projectBookingStatus(from, to)).toEqual({
          kind: 'APPLIED',
          previousStatus: from,
          nextStatus: to,
        });
      });
    }
  });

  // -------------------------------------------------------------------------
  // Tests descriptifs pour NOOP (idempotence).
  // -------------------------------------------------------------------------
  describe('idempotence (NOOP)', () => {
    for (const status of ALL_STATUSES) {
      it(`${status} → ${status} → NOOP`, () => {
        expect(projectBookingStatus(status, status)).toEqual({
          kind: 'NOOP',
          currentStatus: status,
        });
      });
    }
  });

  // -------------------------------------------------------------------------
  // Tests descriptifs pour les états terminaux.
  // -------------------------------------------------------------------------
  describe('états terminaux → TERMINAL_STATE', () => {
    for (const terminal of TERMINAL_STATES) {
      for (const to of ALL_STATUSES) {
        if (to === terminal) continue;
        it(`${terminal} → ${to} → TERMINAL_STATE`, () => {
          try {
            projectBookingStatus(terminal, to);
            throw new Error('devrait avoir levé BookingTransitionError');
          } catch (err) {
            expect(err).toBeInstanceOf(BookingTransitionError);
            const e = err as BookingTransitionError;
            expect(e.code).toBe('TERMINAL_STATE');
            expect(e.fromStatus).toBe(terminal);
            expect(e.toStatus).toBe(to);
          }
        });
      }
    }
  });

  // -------------------------------------------------------------------------
  // Tests descriptifs pour les transitions produit non encore autorisées.
  // -------------------------------------------------------------------------
  describe('transitions produit non encore autorisées', () => {
    it('READY_FOR_PICKUP → CANCELLED → INVALID_TRANSITION', () => {
      try {
        projectBookingStatus('READY_FOR_PICKUP', 'CANCELLED');
        throw new Error('devrait avoir levé BookingTransitionError');
      } catch (err) {
        expect(err).toBeInstanceOf(BookingTransitionError);
        const e = err as BookingTransitionError;
        expect(e.code).toBe('INVALID_TRANSITION');
        expect(e.fromStatus).toBe('READY_FOR_PICKUP');
        expect(e.toStatus).toBe('CANCELLED');
      }
    });

    const versRefunded: Array<[BookingStatus, 'INVALID_TRANSITION' | 'TERMINAL_STATE']> = [
      ['READY_FOR_PICKUP', 'INVALID_TRANSITION'],
      ['ACTIVE', 'INVALID_TRANSITION'],
      ['RETURNED', 'INVALID_TRANSITION'],
      ['CLOSED', 'TERMINAL_STATE'],
    ];
    for (const [from, expectedCode] of versRefunded) {
      it(`${from} → REFUNDED → ${expectedCode}`, () => {
        try {
          projectBookingStatus(from, 'REFUNDED');
          throw new Error('devrait avoir levé BookingTransitionError');
        } catch (err) {
          expect(err).toBeInstanceOf(BookingTransitionError);
          const e = err as BookingTransitionError;
          expect(e.code).toBe(expectedCode);
          expect(e.fromStatus).toBe(from);
          expect(e.toStatus).toBe('REFUNDED');
        }
      });
    }
  });
});
