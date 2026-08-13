/**
 * @uttily/core — Tests unitaires de validation runtime pour le module outbox-claim
 * (G5D Round 4, ADR-013 §7).
 *
 * Ces tests sont PURS : aucun PostgreSQL requis. Ils vérifient que
 * validateHandlerSelection et validateClaimEligibility rejettent correctement
 * les valeurs forgées et acceptent uniquement les valeurs autorisées.
 */

import { describe, expect, it } from 'vitest';
import {
  validateHandlerSelection,
  validateClaimEligibility,
  BOOKING_CONFIRMED_SELECTION,
  PAYMENT_COMPENSATION_SELECTION,
  REFUND_REQUEST_SELECTION,
  claimOutboxBatch,
} from './index';

// ─────────────────────────────────────────────────────────────────────────────
// validateHandlerSelection
// ─────────────────────────────────────────────────────────────────────────────

describe('validateHandlerSelection — runtime validation (closed union)', () => {
  // Nominal cases — must NOT throw, must return canonical value.
  it('accepte BOOKING_CONFIRMED et retourne une valeur canonique', () => {
    const input = {
      kind: 'BOOKING_CONFIRMED',
      eventType: 'BOOKING_CONFIRMED',
      eventVersion: 'v1',
      aggregateType: 'BOOKING',
    };
    const result = validateHandlerSelection(input);
    expect(result).toEqual(BOOKING_CONFIRMED_SELECTION);
    // Must be a NEW object, not the same reference as input.
    expect(result).not.toBe(input);
    // Must have exactly the 4 keys.
    expect(Object.keys(result).sort()).toEqual([
      'aggregateType',
      'eventType',
      'eventVersion',
      'kind',
    ]);
  });

  it('accepte PAYMENT_COMPENSATION et retourne une valeur canonique', () => {
    const input = {
      kind: 'PAYMENT_COMPENSATION',
      eventType: 'PAYMENT_COMPENSATION_REQUESTED',
      eventVersion: 'v1',
      aggregateType: 'PAYMENT',
    };
    const result = validateHandlerSelection(input);
    expect(result).toEqual(PAYMENT_COMPENSATION_SELECTION);
    expect(result).not.toBe(input);
    expect(Object.keys(result).sort()).toEqual([
      'aggregateType',
      'eventType',
      'eventVersion',
      'kind',
    ]);
  });

  it('accepte REFUND_REQUESTED.v1/REFUND et retourne une valeur canonique', () => {
    const input = {
      kind: 'REFUND_REQUEST',
      eventType: 'REFUND_REQUESTED',
      eventVersion: 'v1',
      aggregateType: 'REFUND',
    };
    const result = validateHandlerSelection(input);
    expect(result).toEqual(REFUND_REQUEST_SELECTION);
    expect(result).not.toBe(input);
  });

  // Rejection cases — all must throw.
  it('rejette null', () => {
    expect(() => validateHandlerSelection(null)).toThrow();
  });

  it('rejette undefined', () => {
    expect(() => validateHandlerSelection(undefined)).toThrow();
  });

  it('rejette un tableau vide', () => {
    expect(() => validateHandlerSelection([])).toThrow();
  });

  it('rejette un tableau non vide', () => {
    expect(() => validateHandlerSelection([1, 2])).toThrow();
  });

  it('rejette un kind inconnu', () => {
    expect(() => validateHandlerSelection({ kind: 'UNKNOWN' })).toThrow();
  });

  it('rejette un tuple BOOKING_CONFIRMED avec wrong eventType', () => {
    expect(() =>
      validateHandlerSelection({
        kind: 'BOOKING_CONFIRMED',
        eventType: 'WRONG',
        eventVersion: 'v1',
        aggregateType: 'BOOKING',
      }),
    ).toThrow();
  });

  it('rejette un tuple BOOKING_CONFIRMED avec wrong eventVersion', () => {
    expect(() =>
      validateHandlerSelection({
        kind: 'BOOKING_CONFIRMED',
        eventType: 'BOOKING_CONFIRMED',
        eventVersion: 'v2',
        aggregateType: 'BOOKING',
      }),
    ).toThrow();
  });

  it('rejette un tuple BOOKING_CONFIRMED avec wrong aggregateType', () => {
    expect(() =>
      validateHandlerSelection({
        kind: 'BOOKING_CONFIRMED',
        eventType: 'BOOKING_CONFIRMED',
        eventVersion: 'v1',
        aggregateType: 'WRONG',
      }),
    ).toThrow();
  });

  it('rejette un objet avec une propriété manquante (missing aggregateType)', () => {
    expect(() =>
      validateHandlerSelection({
        kind: 'BOOKING_CONFIRMED',
        eventType: 'BOOKING_CONFIRMED',
        eventVersion: 'v1',
      }),
    ).toThrow();
  });

  it('rejette un objet avec une propriété supplémentaire (extra key)', () => {
    expect(() =>
      validateHandlerSelection({
        kind: 'BOOKING_CONFIRMED',
        eventType: 'BOOKING_CONFIRMED',
        eventVersion: 'v1',
        aggregateType: 'BOOKING',
        extra: 'malicious',
      }),
    ).toThrow();
  });

  it('rejette une chaîne de caractères', () => {
    expect(() => validateHandlerSelection('BOOKING_CONFIRMED')).toThrow();
  });

  it('rejette un nombre', () => {
    expect(() => validateHandlerSelection(42)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateClaimEligibility
// ─────────────────────────────────────────────────────────────────────────────

describe('validateClaimEligibility — runtime validation (closed union)', () => {
  it('accepte ALL_HANDLER_EVENTS', () => {
    expect(validateClaimEligibility('ALL_HANDLER_EVENTS')).toBe('ALL_HANDLER_EVENTS');
  });

  it('accepte INCOMPLETE_DOCUMENT_GENERATION', () => {
    expect(validateClaimEligibility('INCOMPLETE_DOCUMENT_GENERATION')).toBe(
      'INCOMPLETE_DOCUMENT_GENERATION',
    );
  });

  it('accepte READY_FOR_TRANSACTIONAL_EMAIL', () => {
    expect(validateClaimEligibility('READY_FOR_TRANSACTIONAL_EMAIL')).toBe(
      'READY_FOR_TRANSACTIONAL_EMAIL',
    );
  });

  it('rejette une valeur forgée', () => {
    expect(() => validateClaimEligibility('FORGED_VALUE')).toThrow();
  });

  it('rejette null', () => {
    expect(() => validateClaimEligibility(null)).toThrow();
  });

  it('rejette undefined', () => {
    expect(() => validateClaimEligibility(undefined)).toThrow();
  });

  it('rejette un nombre', () => {
    expect(() => validateClaimEligibility(42)).toThrow();
  });

  it('rejette un objet', () => {
    expect(() => validateClaimEligibility({})).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// claimOutboxBatch — forged eligibility throws BEFORE any SQL
// ─────────────────────────────────────────────────────────────────────────────

describe('claimOutboxBatch — forged eligibility throws before any SQL', () => {
  it('ne exécute aucun SQL quand eligibility est forgée', async () => {
    let executeCallCount = 0;
    const fakeTx = {
      execute: async () => {
        executeCallCount++;
        return [];
      },
    };

    await expect(
      claimOutboxBatch(
        fakeTx as never,
        BOOKING_CONFIRMED_SELECTION,
        5,
        'always',
        'FORGED_VALUE' as never,
      ),
    ).rejects.toThrow();

    // validateClaimEligibility must throw BEFORE any SQL is executed.
    expect(executeCallCount).toBe(0);
  });
});
