import { describe, expect, it } from 'vitest';
import {
  getEffectiveBooking,
  parseFinancialSnapshot,
  normalizeAggregateAmount,
  assertFinancialInvariant,
} from './get-effective-booking';
import { EffectiveBookingError, isEffectiveBookingErrorCode } from './errors';
import * as publicBarrel from './index';
import * as coreIndex from '../index';

const MAX_SAFE_INTEGER = 9007199254740991;

describe('parseFinancialSnapshot', () => {
  it('valide un snapshot correct', () => {
    const result = parseFinancialSnapshot({ totalAmountMinor: 12000, currency: 'EUR' }, 'test');
    expect(result).toEqual({ totalAmountMinor: 12000, currency: 'EUR' });
  });

  it('rejette un snapshot non-objet (null)', () => {
    expect(() => parseFinancialSnapshot(null, 'test')).toThrow(EffectiveBookingError);
    expect(() => parseFinancialSnapshot(null, 'test')).toThrow(/n'est pas un objet/);
  });

  it('rejette un snapshot non-objet (tableau)', () => {
    expect(() => parseFinancialSnapshot([1, 2], 'test')).toThrow(EffectiveBookingError);
    expect(() => parseFinancialSnapshot([1, 2], 'test')).toThrow(/n'est pas un objet/);
  });

  it('rejette totalAmountMinor non-entier', () => {
    expect(() =>
      parseFinancialSnapshot({ totalAmountMinor: 12.5, currency: 'EUR' }, 'test'),
    ).toThrow(/n'est pas un entier/);
  });

  it('rejette totalAmountMinor négatif', () => {
    expect(() =>
      parseFinancialSnapshot({ totalAmountMinor: -100, currency: 'EUR' }, 'test'),
    ).toThrow(/négatif/);
  });

  it('rejette totalAmountMinor dépassant MAX_SAFE_INTEGER', () => {
    expect(() =>
      parseFinancialSnapshot({ totalAmountMinor: 9007199254740992, currency: 'EUR' }, 'test'),
    ).toThrow(/MAX_SAFE_INTEGER/);
  });

  it('rejette currency manquante', () => {
    expect(() => parseFinancialSnapshot({ totalAmountMinor: 1000 }, 'test')).toThrow(
      /currency est manquante/,
    );
  });

  it('rejette currency vide', () => {
    expect(() => parseFinancialSnapshot({ totalAmountMinor: 1000, currency: '' }, 'test')).toThrow(
      /currency est manquante ou vide/,
    );
  });

  it('rejette currency non-EUR', () => {
    expect(() =>
      parseFinancialSnapshot({ totalAmountMinor: 1000, currency: 'USD' }, 'test'),
    ).toThrow(/EUR attendu/);
  });

  it('rejette totalAmountMinor NaN', () => {
    expect(() =>
      parseFinancialSnapshot({ totalAmountMinor: NaN, currency: 'EUR' }, 'test'),
    ).toThrow(/n'est pas un entier/);
  });

  it('rejette totalAmountMinor string', () => {
    expect(() =>
      parseFinancialSnapshot({ totalAmountMinor: '1000', currency: 'EUR' }, 'test'),
    ).toThrow(/n'est pas un entier/);
  });

  it("inclut le contexte dans le message d'erreur", () => {
    expect(() =>
      parseFinancialSnapshot({ totalAmountMinor: -1, currency: 'EUR' }, 'amendment 3'),
    ).toThrow(/amendment 3/);
  });
});

describe('EffectiveBookingError', () => {
  it("porte le code d'erreur", () => {
    const err = new EffectiveBookingError('VALIDATION', 'test message');
    expect(err.code).toBe('VALIDATION');
    expect(err.message).toBe('test message');
    expect(err.name).toBe('EffectiveBookingError');
  });

  it('est une instance de Error', () => {
    const err = new EffectiveBookingError('SNAPSHOT_INVALID', 'test');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('getEffectiveBooking — validation UUID', () => {
  // Un faux db qui lèverait une erreur s'il était appelé — la validation
  // doit échouer avant toute requête DB.
  const failDb = {
    select: () => {
      throw new Error('DB ne doit pas être appelée avec un UUID invalide');
    },
  } as unknown as Parameters<typeof getEffectiveBooking>[0];

  it('rejette organizationId invalide', async () => {
    await expect(
      getEffectiveBooking(failDb, 'not-a-uuid', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    ).rejects.toThrow(EffectiveBookingError);
    await expect(
      getEffectiveBooking(failDb, 'not-a-uuid', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    ).rejects.toThrow(/organizationId invalide/);
  });

  it('rejette bookingId invalide', async () => {
    await expect(
      getEffectiveBooking(failDb, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'not-a-uuid'),
    ).rejects.toThrow(EffectiveBookingError);
    await expect(
      getEffectiveBooking(failDb, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'not-a-uuid'),
    ).rejects.toThrow(/bookingId invalide/);
  });

  it('rejette les deux invalides (organizationId en premier)', async () => {
    await expect(getEffectiveBooking(failDb, '', '')).rejects.toThrow(/organizationId invalide/);
  });
});

describe('normalizeAggregateAmount', () => {
  it('normalise null en zéro (aucune ligne)', () => {
    expect(normalizeAggregateAmount(null, 'test')).toBe(0);
  });

  it('retourne un entier sûr positif tel quel', () => {
    expect(normalizeAggregateAmount(5000, 'test')).toBe(5000);
  });

  it('retourne zéro tel quel', () => {
    expect(normalizeAggregateAmount(0, 'test')).toBe(0);
  });

  it('rejette un non-entier', () => {
    expect(() => normalizeAggregateAmount(12.5, 'test')).toThrow(EffectiveBookingError);
    expect(() => normalizeAggregateAmount(12.5, 'test')).toThrow(/non-entier/);
  });

  it('rejette NaN', () => {
    expect(() => normalizeAggregateAmount(NaN, 'test')).toThrow(EffectiveBookingError);
    expect(() => normalizeAggregateAmount(NaN, 'test')).toThrow(/non-entier/);
  });

  it('rejette un montant négatif', () => {
    expect(() => normalizeAggregateAmount(-100, 'test')).toThrow(EffectiveBookingError);
    expect(() => normalizeAggregateAmount(-100, 'test')).toThrow(/négatif/);
  });

  it('rejette un montant dépassant MAX_SAFE_INTEGER', () => {
    expect(() => normalizeAggregateAmount(9007199254740992, 'test')).toThrow(EffectiveBookingError);
    expect(() => normalizeAggregateAmount(9007199254740992, 'test')).toThrow(/MAX_SAFE_INTEGER/);
  });

  it('inclut le contexte dans le message', () => {
    expect(() => normalizeAggregateAmount(-1, 'grossCollected')).toThrow(/grossCollected/);
  });
});

describe('assertFinancialInvariant', () => {
  function captureError(fn: () => void): EffectiveBookingError {
    try {
      fn();
    } catch (e) {
      if (e instanceof EffectiveBookingError) return e;
      throw e;
    }
    throw new Error('devrait avoir levé une EffectiveBookingError');
  }

  it("accepte l'égalité exacte (15000 - 3000 - 300 - 500 = 11200)", () => {
    expect(() => assertFinancialInvariant(15000, 3000, 300, 500, 11200)).not.toThrow();
  });

  it("accepte l'égalité avec zéros", () => {
    expect(() => assertFinancialInvariant(10000, 0, 0, 0, 10000)).not.toThrow();
  });

  it('rejette quand le solde est supérieur au total contractuel', () => {
    // solde = 11200, contractualTotal = 10000
    expect(() => assertFinancialInvariant(15000, 3000, 300, 500, 10000)).toThrow(
      EffectiveBookingError,
    );
    const err = captureError(() => assertFinancialInvariant(15000, 3000, 300, 500, 10000));
    expect(err.code).toBe('FINANCIAL_INVARIANT_VIOLATION');
    expect(err.message).toContain('11200');
    expect(err.message).toContain('10000');
  });

  it('rejette quand le solde est inférieur au total contractuel', () => {
    // solde = 8000, contractualTotal = 10000
    expect(() => assertFinancialInvariant(10000, 2000, 0, 0, 10000)).toThrow(EffectiveBookingError);
    const err = captureError(() => assertFinancialInvariant(10000, 2000, 0, 0, 10000));
    expect(err.code).toBe('FINANCIAL_INVARIANT_VIOLATION');
    expect(err.message).toContain('8000');
    expect(err.message).toContain('10000');
  });

  it('rejette un montant non-entier (12.5)', () => {
    expect(() => assertFinancialInvariant(12.5, 0, 0, 0, 12)).toThrow(EffectiveBookingError);
    const err = captureError(() => assertFinancialInvariant(12.5, 0, 0, 0, 12));
    expect(err.code).toBe('FINANCIAL_INVARIANT_VIOLATION');
    expect(err.message).toContain('grossCollected=12.5');
  });

  it('rejette un montant dépassant MAX_SAFE_INTEGER', () => {
    const over = MAX_SAFE_INTEGER + 1;
    expect(() => assertFinancialInvariant(over, 0, 0, 0, over)).toThrow(EffectiveBookingError);
    const err = captureError(() => assertFinancialInvariant(over, 0, 0, 0, over));
    expect(err.code).toBe('FINANCIAL_INVARIANT_VIOLATION');
  });

  it('rejette un montant négatif', () => {
    expect(() => assertFinancialInvariant(-100, 0, 0, 0, -100)).toThrow(EffectiveBookingError);
    const err = captureError(() => assertFinancialInvariant(-100, 0, 0, 0, -100));
    expect(err.code).toBe('FINANCIAL_INVARIANT_VIOLATION');
  });

  it("l'erreur ne contient pas de PII ni donnée provider", () => {
    try {
      assertFinancialInvariant(15000, 3000, 300, 500, 9999);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toMatch(/@|email|provider|stripe|acct_/i);
      expect(msg).toContain('grossCollected');
      expect(msg).toContain('contractualTotal');
    }
  });
});

describe('Exports publics — helpers internes non exposés', () => {
  it("parseFinancialSnapshot n'est pas exporté depuis le barrel public", () => {
    expect((publicBarrel as Record<string, unknown>).parseFinancialSnapshot).toBeUndefined();
  });

  it("normalizeAggregateAmount n'est pas exporté depuis le barrel public", () => {
    expect((publicBarrel as Record<string, unknown>).normalizeAggregateAmount).toBeUndefined();
  });

  it("assertFinancialInvariant n'est pas exporté depuis le barrel public", () => {
    expect((publicBarrel as Record<string, unknown>).assertFinancialInvariant).toBeUndefined();
  });

  it("isEffectiveBookingErrorCode n'est pas exporté depuis le barrel public", () => {
    expect((publicBarrel as Record<string, unknown>).isEffectiveBookingErrorCode).toBeUndefined();
  });

  it("FinancialSnapshot n'est pas exporté depuis le barrel public", () => {
    expect((publicBarrel as Record<string, unknown>).FinancialSnapshot).toBeUndefined();
  });

  it("parseFinancialSnapshot n'est pas exporté depuis @uttily/core", () => {
    expect((coreIndex as Record<string, unknown>).parseFinancialSnapshot).toBeUndefined();
  });

  it("normalizeAggregateAmount n'est pas exporté depuis @uttily/core", () => {
    expect((coreIndex as Record<string, unknown>).normalizeAggregateAmount).toBeUndefined();
  });

  it("assertFinancialInvariant n'est pas exporté depuis @uttily/core", () => {
    expect((coreIndex as Record<string, unknown>).assertFinancialInvariant).toBeUndefined();
  });

  it("isEffectiveBookingErrorCode n'est pas exporté depuis @uttily/core", () => {
    expect((coreIndex as Record<string, unknown>).isEffectiveBookingErrorCode).toBeUndefined();
  });

  it('getEffectiveBooking est exporté depuis le barrel public', () => {
    expect(typeof publicBarrel.getEffectiveBooking).toBe('function');
  });

  it('EffectiveBookingError est exporté depuis le barrel public', () => {
    expect(typeof publicBarrel.EffectiveBookingError).toBe('function');
  });

  it('UNKNOWN ne fait pas partie des codes publics', () => {
    const err = new EffectiveBookingError('VALIDATION', 'test');
    expect(err.code).not.toBe('UNKNOWN');
    // TypeScript compile-time: 'UNKNOWN' n'est plus assignable à EffectiveBookingErrorCode
  });

  it("FINANCIAL_INVARIANT_VIOLATION est un code d'erreur valide", () => {
    const err = new EffectiveBookingError('FINANCIAL_INVARIANT_VIOLATION', 'test');
    expect(err.code).toBe('FINANCIAL_INVARIANT_VIOLATION');
    expect(isEffectiveBookingErrorCode('FINANCIAL_INVARIANT_VIOLATION')).toBe(true);
  });
});
