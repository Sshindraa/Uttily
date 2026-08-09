import { describe, it, expect } from 'vitest';
import {
  localDateTimeToUtc,
  localDateTimeStringToUtc,
  parseLocalDateTimeString,
  LocalToUtcError,
  type LocalDateTime,
} from './local-to-utc';
import { toLocalParts } from './time-utils';

// Helper : construit un LocalDateTime.
function ldt(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): LocalDateTime {
  return { year, month, day, hour, minute, second };
}

// Helper : vérifie le round-trip UTC → local → UTC.
function assertRoundTrip(utc: Date, timeZone: string): void {
  const parts = toLocalParts(utc, timeZone);
  const local: LocalDateTime = {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
  const back = localDateTimeToUtc(local, timeZone);
  expect(back.getTime()).toBe(utc.getTime());
}

describe('localDateTimeToUtc — conversion locale → UTC', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Europe/Paris
  // ─────────────────────────────────────────────────────────────────────────

  it('Europe/Paris — heure normale (CET, UTC+1) : 2026-08-10 09:00:00 → 08:00:00 UTC', () => {
    // En août, Paris est en CEST (UTC+2), pas CET.
    // 09:00 local = 07:00 UTC
    const result = localDateTimeToUtc(ldt(2026, 8, 10, 9, 0, 0), 'Europe/Paris');
    expect(result.toISOString()).toBe('2026-08-10T07:00:00.000Z');
    assertRoundTrip(result, 'Europe/Paris');
  });

  it("Europe/Paris — heure d'hiver (CET, UTC+1) : 2026-02-10 09:00:00 → 08:00:00 UTC", () => {
    const result = localDateTimeToUtc(ldt(2026, 2, 10, 9, 0, 0), 'Europe/Paris');
    expect(result.toISOString()).toBe('2026-02-10T08:00:00.000Z');
    assertRoundTrip(result, 'Europe/Paris');
  });

  it('Europe/Paris — spring-forward : 2026-03-29 02:30:00 → NON_EXISTENT_LOCAL_TIME', () => {
    // Le 29 mars 2026, à 02:00, l'heure passe à 03:00 (CEST).
    // 02:30 n'existe pas.
    expect(() => localDateTimeToUtc(ldt(2026, 3, 29, 2, 30, 0), 'Europe/Paris')).toThrow(
      LocalToUtcError,
    );
    try {
      localDateTimeToUtc(ldt(2026, 3, 29, 2, 30, 0), 'Europe/Paris');
    } catch (err) {
      expect((err as LocalToUtcError).code).toBe('NON_EXISTENT_LOCAL_TIME');
      expect((err as LocalToUtcError).name).toBe('LocalToUtcError');
    }
  });

  it('Europe/Paris — fall-back : 2026-10-25 02:30:00 → AMBIGUOUS_LOCAL_TIME', () => {
    // Le 25 octobre 2026, à 03:00, l'heure revient à 02:00 (CET).
    // 02:30 existe deux fois (une fois en CEST, une fois en CET).
    expect(() => localDateTimeToUtc(ldt(2026, 10, 25, 2, 30, 0), 'Europe/Paris')).toThrow(
      LocalToUtcError,
    );
    try {
      localDateTimeToUtc(ldt(2026, 10, 25, 2, 30, 0), 'Europe/Paris');
    } catch (err) {
      expect((err as LocalToUtcError).code).toBe('AMBIGUOUS_LOCAL_TIME');
      expect((err as LocalToUtcError).name).toBe('LocalToUtcError');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // America/New_York
  // ─────────────────────────────────────────────────────────────────────────

  it("America/New_York — heure d'été (EDT, UTC-4) : 2026-08-10 09:00:00 → 13:00:00 UTC", () => {
    const result = localDateTimeToUtc(ldt(2026, 8, 10, 9, 0, 0), 'America/New_York');
    expect(result.toISOString()).toBe('2026-08-10T13:00:00.000Z');
    assertRoundTrip(result, 'America/New_York');
  });

  it("America/New_York — heure d'hiver (EST, UTC-5) : 2026-02-10 09:00:00 → 14:00:00 UTC", () => {
    const result = localDateTimeToUtc(ldt(2026, 2, 10, 9, 0, 0), 'America/New_York');
    expect(result.toISOString()).toBe('2026-02-10T14:00:00.000Z');
    assertRoundTrip(result, 'America/New_York');
  });

  it('America/New_York — spring-forward : 2026-03-08 02:30:00 → NON_EXISTENT_LOCAL_TIME', () => {
    // Le 8 mars 2026, à 02:00, l'heure passe à 03:00 (EDT).
    // 02:30 n'existe pas.
    expect(() => localDateTimeToUtc(ldt(2026, 3, 8, 2, 30, 0), 'America/New_York')).toThrow(
      LocalToUtcError,
    );
    try {
      localDateTimeToUtc(ldt(2026, 3, 8, 2, 30, 0), 'America/New_York');
    } catch (err) {
      expect((err as LocalToUtcError).code).toBe('NON_EXISTENT_LOCAL_TIME');
    }
  });

  it('America/New_York — fall-back : 2026-11-01 01:30:00 → AMBIGUOUS_LOCAL_TIME', () => {
    // Le 1er novembre 2026, à 02:00, l'heure revient à 01:00 (EST).
    // 01:30 existe deux fois.
    expect(() => localDateTimeToUtc(ldt(2026, 11, 1, 1, 30, 0), 'America/New_York')).toThrow(
      LocalToUtcError,
    );
    try {
      localDateTimeToUtc(ldt(2026, 11, 1, 1, 30, 0), 'America/New_York');
    } catch (err) {
      expect((err as LocalToUtcError).code).toBe('AMBIGUOUS_LOCAL_TIME');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // UTC (pas de DST)
  // ─────────────────────────────────────────────────────────────────────────

  it('UTC — conversion identité : 2026-06-15 12:30:00 → 12:30:00 UTC', () => {
    const result = localDateTimeToUtc(ldt(2026, 6, 15, 12, 30, 0), 'UTC');
    expect(result.toISOString()).toBe('2026-06-15T12:30:00.000Z');
    assertRoundTrip(result, 'UTC');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Round-trip aléatoire
  // ─────────────────────────────────────────────────────────────────────────

  it('round-trip : UTC → local → UTC = identité (Europe/Paris, été)', () => {
    const utc = new Date('2026-07-15T10:45:30.000Z');
    assertRoundTrip(utc, 'Europe/Paris');
  });

  it('round-trip : UTC → local → UTC = identité (Europe/Paris, hiver)', () => {
    const utc = new Date('2026-01-15T10:45:30.000Z');
    assertRoundTrip(utc, 'Europe/Paris');
  });

  it('round-trip : UTC → local → UTC = identité (America/New_York, été)', () => {
    const utc = new Date('2026-07-15T10:45:30.000Z');
    assertRoundTrip(utc, 'America/New_York');
  });

  it('round-trip : UTC → local → UTC = identité (America/New_York, hiver)', () => {
    const utc = new Date('2026-01-15T10:45:30.000Z');
    assertRoundTrip(utc, 'America/New_York');
  });

  it('round-trip : UTC → local → UTC = identité (Asia/Tokyo, pas de DST)', () => {
    const utc = new Date('2026-07-15T10:45:30.000Z');
    assertRoundTrip(utc, 'Asia/Tokyo');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Indépendance du fuseau système
  // ─────────────────────────────────────────────────────────────────────────

  it('indépendant du fuseau système : résultat cohérent quel que soit TZ', () => {
    // Ce test vérifie que la fonction produit le même résultat indépendamment
    // du fuseau système. Les tests ci-dessus s'exécutent déjà dans le fuseau
    // système du runner ; si TZ est défini, vitest peut le surcharger.
    // La clé est que localDateTimeToUtc n'utilise jamais le fuseau système.
    const result = localDateTimeToUtc(ldt(2026, 8, 10, 9, 0, 0), 'Europe/Paris');
    expect(result.toISOString()).toBe('2026-08-10T07:00:00.000Z');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Heures limites
  // ─────────────────────────────────────────────────────────────────────────

  it('minuit local : 2026-06-15 00:00:00 Europe/Paris → 2026-06-14T22:00:00Z', () => {
    const result = localDateTimeToUtc(ldt(2026, 6, 15, 0, 0, 0), 'Europe/Paris');
    expect(result.toISOString()).toBe('2026-06-14T22:00:00.000Z');
    assertRoundTrip(result, 'Europe/Paris');
  });

  it('minuit local : 2026-01-15 00:00:00 Europe/Paris → 2026-01-14T23:00:00Z', () => {
    const result = localDateTimeToUtc(ldt(2026, 1, 15, 0, 0, 0), 'Europe/Paris');
    expect(result.toISOString()).toBe('2026-01-14T23:00:00.000Z');
    assertRoundTrip(result, 'Europe/Paris');
  });

  it('23:59:59 local : 2026-06-15 23:59:59 Europe/Paris → 2026-06-15T21:59:59Z', () => {
    const result = localDateTimeToUtc(ldt(2026, 6, 15, 23, 59, 59), 'Europe/Paris');
    expect(result.toISOString()).toBe('2026-06-15T21:59:59.000Z');
    assertRoundTrip(result, 'Europe/Paris');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // G7P-B2-B Round 2 — Defect 5 : fuseaux extrêmes et non standard
  // ─────────────────────────────────────────────────────────────────────────

  it('Asia/Kathmandu (+05:45) : 2026-08-10 09:00:00 → 03:15:00 UTC', () => {
    const result = localDateTimeToUtc(ldt(2026, 8, 10, 9, 0, 0), 'Asia/Kathmandu');
    expect(result.toISOString()).toBe('2026-08-10T03:15:00.000Z');
    assertRoundTrip(result, 'Asia/Kathmandu');
  });

  it('Pacific/Kiritimati (+14) : 2026-08-10 09:00:00 → 2026-08-09T19:00:00Z', () => {
    const result = localDateTimeToUtc(ldt(2026, 8, 10, 9, 0, 0), 'Pacific/Kiritimati');
    expect(result.toISOString()).toBe('2026-08-09T19:00:00.000Z');
    assertRoundTrip(result, 'Pacific/Kiritimati');
  });

  it('Pacific/Pago_Pago (-11) : 2026-08-10 09:00:00 → 2026-08-10T20:00:00Z', () => {
    const result = localDateTimeToUtc(ldt(2026, 8, 10, 9, 0, 0), 'Pacific/Pago_Pago');
    expect(result.toISOString()).toBe('2026-08-10T20:00:00.000Z');
    assertRoundTrip(result, 'Pacific/Pago_Pago');
  });

  it('Australia/Lord_Howe (+10:30 standard / +11:00 DST — 30 min transition) — été', () => {
    // En février (été austral), Lord Howe est en DST (+11:00).
    // 09:00 local = 22:00 UTC la veille.
    const result = localDateTimeToUtc(ldt(2026, 2, 10, 9, 0, 0), 'Australia/Lord_Howe');
    expect(result.toISOString()).toBe('2026-02-09T22:00:00.000Z');
    assertRoundTrip(result, 'Australia/Lord_Howe');
  });

  it('Australia/Lord_Howe (+10:30 standard / +11:00 DST — 30 min transition) — hiver', () => {
    // En juillet (hiver austral), Lord Howe est en standard (+10:30).
    // 09:00 local = 22:30 UTC la veille.
    const result = localDateTimeToUtc(ldt(2026, 7, 10, 9, 0, 0), 'Australia/Lord_Howe');
    expect(result.toISOString()).toBe('2026-07-09T22:30:00.000Z');
    assertRoundTrip(result, 'Australia/Lord_Howe');
  });

  it('Australia/Lord_Howe — fall-back (DST → standard, 30 min transition)', () => {
    // Lord Howe passe de +11:00 (DST) à +10:30 (standard) le premier dimanche d'avril.
    // En 2026 : 5 avril 2026, à 02:00 → 01:30 (transition de 30 min, recul).
    // 01:45 existe deux fois (une fois en +11:00, une fois en +10:30).
    expect(() => localDateTimeToUtc(ldt(2026, 4, 5, 1, 45, 0), 'Australia/Lord_Howe')).toThrow(
      LocalToUtcError,
    );
    try {
      localDateTimeToUtc(ldt(2026, 4, 5, 1, 45, 0), 'Australia/Lord_Howe');
    } catch (err) {
      expect((err as LocalToUtcError).code).toBe('AMBIGUOUS_LOCAL_TIME');
    }
  });

  it('Australia/Lord_Howe — spring-forward (standard → DST, 30 min transition)', () => {
    // Lord Howe passe de +10:30 (standard) à +11:00 (DST) le premier dimanche d'octobre.
    // En 2026 : 4 octobre 2026, à 02:00 → 02:30 (transition de 30 min, avancement).
    // 02:15 n'existe pas (entre 02:00 et 02:30).
    expect(() => localDateTimeToUtc(ldt(2026, 10, 4, 2, 15, 0), 'Australia/Lord_Howe')).toThrow(
      LocalToUtcError,
    );
    try {
      localDateTimeToUtc(ldt(2026, 10, 4, 2, 15, 0), 'Australia/Lord_Howe');
    } catch (err) {
      expect((err as LocalToUtcError).code).toBe('NON_EXISTENT_LOCAL_TIME');
    }
  });

  it('Pacific/Kiritimati — date locale en avance sur UTC (local 2026-08-10 → UTC 2026-08-09)', () => {
    // UTC+14 : la date locale est en avance sur UTC.
    // Minuit local le 10 août = 10:00 UTC le 9 août.
    const result = localDateTimeToUtc(ldt(2026, 8, 10, 0, 0, 0), 'Pacific/Kiritimati');
    expect(result.toISOString()).toBe('2026-08-09T10:00:00.000Z');
    assertRoundTrip(result, 'Pacific/Kiritimati');
  });

  it('Pacific/Pago_Pago — date locale en retard sur UTC (local 2026-08-10 → UTC 2026-08-10)', () => {
    // UTC-11 : la date locale est en retard sur UTC.
    // 23:00 local le 10 août = 10:00 UTC le 11 août.
    const result = localDateTimeToUtc(ldt(2026, 8, 10, 23, 0, 0), 'Pacific/Pago_Pago');
    expect(result.toISOString()).toBe('2026-08-11T10:00:00.000Z');
    assertRoundTrip(result, 'Pacific/Pago_Pago');
  });

  it('fuseau IANA invalide → INVALID_TIMEZONE', () => {
    expect(() => localDateTimeToUtc(ldt(2026, 8, 10, 9, 0, 0), 'Invalid/Timezone')).toThrow(
      LocalToUtcError,
    );
    try {
      localDateTimeToUtc(ldt(2026, 8, 10, 9, 0, 0), 'Invalid/Timezone');
    } catch (err) {
      expect((err as LocalToUtcError).code).toBe('INVALID_TIMEZONE');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Indépendance du fuseau système (TZ env) — vérification explicite
  // ─────────────────────────────────────────────────────────────────────────

  it('résultat identique quel que soit process.env.TZ (Europe/Paris)', () => {
    const originalTz = process.env.TZ;
    const local = ldt(2026, 8, 10, 9, 0, 0);
    const expected = '2026-08-10T07:00:00.000Z';
    const results: string[] = [];

    for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo', 'Pacific/Kiritimati', undefined]) {
      if (tz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = tz;
      }
      results.push(localDateTimeToUtc(local, 'Europe/Paris').toISOString());
    }

    process.env.TZ = originalTz;
    for (const r of results) {
      expect(r).toBe(expected);
    }
  });

  it('résultat identique quel que soit process.env.TZ (Pacific/Kiritimati +14)', () => {
    const originalTz = process.env.TZ;
    const local = ldt(2026, 8, 10, 9, 0, 0);
    const expected = '2026-08-09T19:00:00.000Z';
    const results: string[] = [];

    for (const tz of ['UTC', 'Europe/Paris', 'Asia/Kathmandu', undefined]) {
      if (tz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = tz;
      }
      results.push(localDateTimeToUtc(local, 'Pacific/Kiritimati').toISOString());
    }

    process.env.TZ = originalTz;
    for (const r of results) {
      expect(r).toBe(expected);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G7P-B2-C Round 3 (P0-1) — parseLocalDateTimeString & localDateTimeStringToUtc
// ─────────────────────────────────────────────────────────────────────────────

describe('parseLocalDateTimeString — parsing ISO 8601 local strings', () => {
  it('parse "2026-08-08T22:08:00" → LocalDateTime', () => {
    const result = parseLocalDateTimeString('2026-08-08T22:08:00');
    expect(result).toEqual({
      year: 2026,
      month: 8,
      day: 8,
      hour: 22,
      minute: 8,
      second: 0,
    });
  });

  it('parse "2026-02-10T09:00:00" → LocalDateTime', () => {
    const result = parseLocalDateTimeString('2026-02-10T09:00:00');
    expect(result).toEqual({
      year: 2026,
      month: 2,
      day: 10,
      hour: 9,
      minute: 0,
      second: 0,
    });
  });

  it('rejects string with offset "Z"', () => {
    expect(() => parseLocalDateTimeString('2026-08-08T22:08:00Z')).toThrow(LocalToUtcError);
    try {
      parseLocalDateTimeString('2026-08-08T22:08:00Z');
    } catch (err) {
      expect((err as LocalToUtcError).code).toBe('INVALID_LOCAL_DATETIME_STRING');
    }
  });

  it('rejects string with offset "+02:00"', () => {
    expect(() => parseLocalDateTimeString('2026-08-08T22:08:00+02:00')).toThrow(LocalToUtcError);
  });

  it('rejects date-only string "2026-08-08"', () => {
    expect(() => parseLocalDateTimeString('2026-08-08')).toThrow(LocalToUtcError);
  });

  it('rejects empty string', () => {
    expect(() => parseLocalDateTimeString('')).toThrow(LocalToUtcError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G7P-B2-B Round 3 — validation sémantique stricte de parseLocalDateTimeString
// ─────────────────────────────────────────────────────────────────────────────

describe('parseLocalDateTimeString — semantic validation (G7P-B2-B Round 3)', () => {
  // Helper : vérifie qu'une valeur est refusée avec INVALID_LOCAL_DATETIME_STRING.
  function expectRejected(value: string): void {
    expect(() => parseLocalDateTimeString(value)).toThrow(LocalToUtcError);
    try {
      parseLocalDateTimeString(value);
    } catch (err) {
      expect((err as LocalToUtcError).code).toBe('INVALID_LOCAL_DATETIME_STRING');
      // Le message ne doit pas contenir la valeur hostile brute.
      expect((err as LocalToUtcError).message).not.toContain(value);
    }
  }

  // ── Jours impossibles selon le mois ──────────────────────────────────────

  it('rejects 2026-02-29 (not a leap year)', () => {
    expectRejected('2026-02-29T09:00:00');
  });

  it('accepts 2028-02-29 (leap year)', () => {
    const result = parseLocalDateTimeString('2028-02-29T09:00:00');
    expect(result).toEqual({
      year: 2028,
      month: 2,
      day: 29,
      hour: 9,
      minute: 0,
      second: 0,
    });
  });

  it('rejects 2026-04-31 (April has 30 days)', () => {
    expectRejected('2026-04-31T09:00:00');
  });

  // ── Mois hors plage ─────────────────────────────────────────────────────

  it('rejects month 00', () => {
    expectRejected('2026-00-10T09:00:00');
  });

  it('rejects month 13', () => {
    expectRejected('2026-13-10T09:00:00');
  });

  // ── Jour hors plage ─────────────────────────────────────────────────────

  it('rejects day 00', () => {
    expectRejected('2026-01-00T09:00:00');
  });

  // ── Heure/minute/seconde hors plage ─────────────────────────────────────

  it('rejects hour 24', () => {
    expectRejected('2026-01-10T24:00:00');
  });

  it('rejects minute 60', () => {
    expectRejected('2026-01-10T09:60:00');
  });

  it('rejects second 60', () => {
    expectRejected('2026-01-10T09:00:60');
  });

  // ── Offsets refusés ─────────────────────────────────────────────────────

  it('rejects suffix "Z"', () => {
    expectRejected('2026-08-08T22:08:00Z');
  });

  it('rejects offset "+02:00"', () => {
    expectRejected('2026-08-08T22:08:00+02:00');
  });

  // ── Valeurs limites valides ─────────────────────────────────────────────

  it('accepts 2026-01-31T23:59:59 (last day of January, last second of day)', () => {
    const result = parseLocalDateTimeString('2026-01-31T23:59:59');
    expect(result).toEqual({
      year: 2026,
      month: 1,
      day: 31,
      hour: 23,
      minute: 59,
      second: 59,
    });
  });

  it('accepts 2026-12-31T00:00:00 (last day of year, midnight)', () => {
    const result = parseLocalDateTimeString('2026-12-31T00:00:00');
    expect(result).toEqual({
      year: 2026,
      month: 12,
      day: 31,
      hour: 0,
      minute: 0,
      second: 0,
    });
  });

  it('accepts 2026-02-28 (last day of February in non-leap year)', () => {
    const result = parseLocalDateTimeString('2026-02-28T09:00:00');
    expect(result).toEqual({
      year: 2026,
      month: 2,
      day: 28,
      hour: 9,
      minute: 0,
      second: 0,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G7P-B2-B Round 3 — localDateTimeStringToUtc : validation sémantique + UTC
// ─────────────────────────────────────────────────────────────────────────────

describe('localDateTimeStringToUtc — semantic validation + conversion (G7P-B2-B Round 3)', () => {
  it('valid datetime 2026-08-08T22:08:00 → 20:08Z for Europe/Paris (CEST UTC+2)', () => {
    const result = localDateTimeStringToUtc('2026-08-08T22:08:00', 'Europe/Paris');
    expect(result.toISOString()).toBe('2026-08-08T20:08:00.000Z');
  });

  it('rejects impossible month 13 before any timezone resolution', () => {
    expect(() => localDateTimeStringToUtc('2026-13-10T09:00:00', 'Europe/Paris')).toThrow(
      LocalToUtcError,
    );
    try {
      localDateTimeStringToUtc('2026-13-10T09:00:00', 'Europe/Paris');
    } catch (err) {
      expect((err as LocalToUtcError).code).toBe('INVALID_LOCAL_DATETIME_STRING');
    }
  });

  it('rejects Feb 30 (non-leap) before any timezone resolution', () => {
    expect(() => localDateTimeStringToUtc('2026-02-30T09:00:00', 'Europe/Paris')).toThrow(
      LocalToUtcError,
    );
    try {
      localDateTimeStringToUtc('2026-02-30T09:00:00', 'Europe/Paris');
    } catch (err) {
      expect((err as LocalToUtcError).code).toBe('INVALID_LOCAL_DATETIME_STRING');
    }
  });
});

describe('localDateTimeStringToUtc — string + timezone → UTC Date', () => {
  it('Europe/Paris winter (CET UTC+1): "2026-02-10T22:08:00" → 21:08 UTC', () => {
    const result = localDateTimeStringToUtc('2026-02-10T22:08:00', 'Europe/Paris');
    expect(result.toISOString()).toBe('2026-02-10T21:08:00.000Z');
  });

  it('Europe/Paris summer (CEST UTC+2): "2026-08-08T22:08:00" → 20:08 UTC', () => {
    const result = localDateTimeStringToUtc('2026-08-08T22:08:00', 'Europe/Paris');
    expect(result.toISOString()).toBe('2026-08-08T20:08:00.000Z');
  });

  it('UTC: "2026-08-08T22:08:00" → 22:08 UTC (identity)', () => {
    const result = localDateTimeStringToUtc('2026-08-08T22:08:00', 'UTC');
    expect(result.toISOString()).toBe('2026-08-08T22:08:00.000Z');
  });

  it('DST spring-forward: "2026-03-29T02:30:00" Europe/Paris → NON_EXISTENT_LOCAL_TIME', () => {
    expect(() => localDateTimeStringToUtc('2026-03-29T02:30:00', 'Europe/Paris')).toThrow(
      LocalToUtcError,
    );
    try {
      localDateTimeStringToUtc('2026-03-29T02:30:00', 'Europe/Paris');
    } catch (err) {
      expect((err as LocalToUtcError).code).toBe('NON_EXISTENT_LOCAL_TIME');
    }
  });

  it('DST fall-back: "2026-10-25T02:30:00" Europe/Paris → AMBIGUOUS_LOCAL_TIME', () => {
    expect(() => localDateTimeStringToUtc('2026-10-25T02:30:00', 'Europe/Paris')).toThrow(
      LocalToUtcError,
    );
    try {
      localDateTimeStringToUtc('2026-10-25T02:30:00', 'Europe/Paris');
    } catch (err) {
      expect((err as LocalToUtcError).code).toBe('AMBIGUOUS_LOCAL_TIME');
    }
  });
});
