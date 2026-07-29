import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { computeFingerprint } from './fingerprint';
import { IdempotencyError } from './errors';
import type { IdempotentPayload } from './types';

const HEX64 = /^[0-9a-f]{64}$/;

function basePayload(overrides: Partial<IdempotentPayload> = {}): IdempotentPayload {
  return {
    organizationId: '11111111-1111-1111-1111-111111111111',
    locationId: '22222222-2222-2222-2222-222222222222',
    customerUserId: '33333333-3333-3333-3333-333333333333',
    customerStartAt: new Date('2026-08-01T10:00:00Z'),
    customerEndAt: new Date('2026-08-03T18:00:00Z'),
    lines: [{ variantId: '44444444-4444-4444-4444-444444444444', quantity: 2 }],
    ...overrides,
  };
}

describe('computeFingerprint', () => {
  // -------------------------------------------------------------------------
  // 1. Empreinte déterministe
  // -------------------------------------------------------------------------
  it('empreinte déterministe : même payload → même empreinte', () => {
    const fp1 = computeFingerprint(basePayload());
    const fp2 = computeFingerprint(basePayload());
    expect(fp1).toBe(fp2);
  });

  // -------------------------------------------------------------------------
  // 2. Format hex64
  // -------------------------------------------------------------------------
  it("l'empreinte correspond à /^[0-9a-f]{64}$/", () => {
    const fp = computeFingerprint(basePayload());
    expect(fp).toMatch(HEX64);
    expect(fp).toHaveLength(64);
  });

  // -------------------------------------------------------------------------
  // 3. Sensibilité au variant_id
  // -------------------------------------------------------------------------
  it('deux payloads avec des variant_id différents → empreintes différentes', () => {
    const fp1 = computeFingerprint(basePayload({ lines: [{ variantId: 'aaaa', quantity: 2 }] }));
    const fp2 = computeFingerprint(basePayload({ lines: [{ variantId: 'bbbb', quantity: 2 }] }));
    expect(fp1).not.toBe(fp2);
  });

  // -------------------------------------------------------------------------
  // 4. Sensibilité à la quantité
  // -------------------------------------------------------------------------
  it('deux payloads avec des quantités différentes → empreintes différentes', () => {
    const fp1 = computeFingerprint(basePayload({ lines: [{ variantId: 'aaaa', quantity: 2 }] }));
    const fp2 = computeFingerprint(basePayload({ lines: [{ variantId: 'aaaa', quantity: 3 }] }));
    expect(fp1).not.toBe(fp2);
  });

  // -------------------------------------------------------------------------
  // 5. Insensibilité à l'ordre des lignes
  // -------------------------------------------------------------------------
  it("l'ordre des lignes ne change pas l'empreinte (tri par variant_id)", () => {
    const lines = [
      { variantId: 'cccc', quantity: 1 },
      { variantId: 'aaaa', quantity: 2 },
      { variantId: 'bbbb', quantity: 3 },
    ];
    const fp1 = computeFingerprint(basePayload({ lines: [...lines] }));
    const fp2 = computeFingerprint(basePayload({ lines: [...lines].reverse() }));
    expect(fp1).toBe(fp2);
  });

  // -------------------------------------------------------------------------
  // 6. Sensibilité aux dates
  // -------------------------------------------------------------------------
  it('des dates différentes → empreintes différentes', () => {
    const fp1 = computeFingerprint(basePayload());
    const fp2 = computeFingerprint(
      basePayload({ customerStartAt: new Date('2026-08-02T10:00:00Z') }),
    );
    expect(fp1).not.toBe(fp2);
  });

  // -------------------------------------------------------------------------
  // 7. Format ISO 8601 UTC
  // -------------------------------------------------------------------------
  it('les dates sont normalisées en ISO 8601 UTC avec Z', () => {
    // Une date construite depuis un timestamp non-UTC doit donner la même
    // empreinte que la date ISO équivalente.
    const d1 = new Date('2026-08-01T12:00:00+02:00');
    const d2 = new Date('2026-08-01T10:00:00Z');
    const fp1 = computeFingerprint(basePayload({ customerStartAt: d1 }));
    const fp2 = computeFingerprint(basePayload({ customerStartAt: d2 }));
    expect(fp1).toBe(fp2);
  });

  // -------------------------------------------------------------------------
  // 8. Version v1 dans l'empreinte
  // -------------------------------------------------------------------------
  it('v: "v1" est présent dans le JSON canonique (comparaison avec hash manuel)', () => {
    const payload = basePayload();
    // Reconstruit le JSON canonique attendu (ordre alphabétique, tri par variant_id).
    const expectedCanonical = JSON.stringify({
      customer_end_at: payload.customerEndAt.toISOString(),
      customer_start_at: payload.customerStartAt.toISOString(),
      customer_user_id: payload.customerUserId,
      lines: [{ variant_id: payload.lines[0]!.variantId, quantity: payload.lines[0]!.quantity }],
      location_id: payload.locationId,
      organization_id: payload.organizationId,
      v: 'v1',
    });
    const expectedHash = createHash('sha256').update(expectedCanonical, 'utf8').digest('hex');
    expect(computeFingerprint(payload)).toBe(expectedHash);
  });

  // -------------------------------------------------------------------------
  // 9. Payload invalide : organizationId vide
  // -------------------------------------------------------------------------
  it('organizationId vide → IdempotencyError(VALIDATION)', () => {
    expect(() => computeFingerprint(basePayload({ organizationId: '' }))).toThrow(IdempotencyError);
    try {
      computeFingerprint(basePayload({ organizationId: '' }));
    } catch (e) {
      expect(e).toBeInstanceOf(IdempotencyError);
      expect((e as IdempotencyError).code).toBe('VALIDATION');
    }
  });

  // -------------------------------------------------------------------------
  // 10. Payload invalide : lines vide
  // -------------------------------------------------------------------------
  it('lines vide → IdempotencyError(VALIDATION)', () => {
    expect(() => computeFingerprint(basePayload({ lines: [] }))).toThrow(IdempotencyError);
    try {
      computeFingerprint(basePayload({ lines: [] }));
    } catch (e) {
      expect((e as IdempotencyError).code).toBe('VALIDATION');
    }
  });

  // -------------------------------------------------------------------------
  // 11. Payload invalide : quantity = 0 ou négatif
  // -------------------------------------------------------------------------
  it('quantity = 0 → IdempotencyError(VALIDATION)', () => {
    expect(() =>
      computeFingerprint(basePayload({ lines: [{ variantId: 'aaaa', quantity: 0 }] })),
    ).toThrow(IdempotencyError);
  });

  it('quantity négatif → IdempotencyError(VALIDATION)', () => {
    expect(() =>
      computeFingerprint(basePayload({ lines: [{ variantId: 'aaaa', quantity: -1 }] })),
    ).toThrow(IdempotencyError);
  });

  // -------------------------------------------------------------------------
  // 12. Payload invalide : Invalid Date
  // -------------------------------------------------------------------------
  it('Invalid Date → IdempotencyError(VALIDATION)', () => {
    expect(() =>
      computeFingerprint(basePayload({ customerStartAt: new Date('not-a-date') })),
    ).toThrow(IdempotencyError);
    try {
      computeFingerprint(basePayload({ customerStartAt: new Date('not-a-date') }));
    } catch (e) {
      expect((e as IdempotencyError).code).toBe('VALIDATION');
    }
  });

  // -------------------------------------------------------------------------
  // 13. Payload invalide : locationId vide
  // -------------------------------------------------------------------------
  it('locationId vide → IdempotencyError(VALIDATION)', () => {
    expect(() => computeFingerprint(basePayload({ locationId: '' }))).toThrow(IdempotencyError);
  });

  // -------------------------------------------------------------------------
  // 14. Payload invalide : customerUserId vide
  // -------------------------------------------------------------------------
  it('customerUserId vide → IdempotencyError(VALIDATION)', () => {
    expect(() => computeFingerprint(basePayload({ customerUserId: '' }))).toThrow(IdempotencyError);
  });

  // -------------------------------------------------------------------------
  // 15. Payload invalide : variantId vide dans une ligne
  // -------------------------------------------------------------------------
  it('variantId vide dans une ligne → IdempotencyError(VALIDATION)', () => {
    expect(() =>
      computeFingerprint(basePayload({ lines: [{ variantId: '', quantity: 2 }] })),
    ).toThrow(IdempotencyError);
  });

  // -------------------------------------------------------------------------
  // 16. Payload invalide : quantity non entier
  // -------------------------------------------------------------------------
  it('quantity non entier (1.5) → IdempotencyError(VALIDATION)', () => {
    expect(() =>
      computeFingerprint(basePayload({ lines: [{ variantId: 'variant-1', quantity: 1.5 }] })),
    ).toThrow(IdempotencyError);
  });

  // -------------------------------------------------------------------------
  // 17. quantity MAX_SAFE_INTEGER acceptée
  // -------------------------------------------------------------------------
  it("quantity = Number.MAX_SAFE_INTEGER → accepté (pas d'erreur)", () => {
    expect(() =>
      computeFingerprint(
        basePayload({
          lines: [{ variantId: 'variant-1', quantity: Number.MAX_SAFE_INTEGER }],
        }),
      ),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // 18. Insensibilité à l'ordre avec doublons de variant_id (tri secondaire par quantity)
  // -------------------------------------------------------------------------
  it("insensibilité à l'ordre des lignes avec doublons de variant_id (tri secondaire par quantity)", () => {
    const payloadA: IdempotentPayload = {
      ...basePayload(),
      lines: [
        { variantId: 'variant-1', quantity: 2 },
        { variantId: 'variant-1', quantity: 1 },
        { variantId: 'variant-2', quantity: 3 },
      ],
    };
    const payloadB: IdempotentPayload = {
      ...basePayload(),
      lines: [
        { variantId: 'variant-2', quantity: 3 },
        { variantId: 'variant-1', quantity: 1 },
        { variantId: 'variant-1', quantity: 2 },
      ],
    };
    expect(computeFingerprint(payloadA)).toBe(computeFingerprint(payloadB));
  });
});
