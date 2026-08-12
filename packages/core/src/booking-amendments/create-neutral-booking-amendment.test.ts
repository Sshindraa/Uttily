import { describe, expect, it } from 'vitest';
import {
  validateCommand,
  computeAmendmentFingerprint,
  computeLineDiff,
  classifyDelta,
} from './create-neutral-booking-amendment';
import type { NeutralAmendmentCommand, NeutralAmendmentDesiredLine } from './types-amendment';
import type { EffectiveLine } from './types';
import { NeutralAmendmentError, isNeutralAmendmentErrorCode } from './types-amendment';

const VALID_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VALID_UUID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VALID_UUID_3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function validCommand(overrides: Partial<NeutralAmendmentCommand> = {}): NeutralAmendmentCommand {
  return {
    bookingId: VALID_UUID,
    expectedLastAppliedAmendmentNumber: 0,
    intent: {
      kind: 'TIME_RANGE',
      startAt: '2026-03-10T09:00:00',
      endAt: '2026-03-12T17:00:00',
    },
    desiredLines: [{ variantId: VALID_UUID_2, quantity: 1 }],
    idempotencyKey: 'test-key-1',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// validateCommand
// ─────────────────────────────────────────────────────────────────────────────

describe('validateCommand', () => {
  it('accepte une commande valide TIME_RANGE', () => {
    expect(validateCommand(validCommand())).toBeNull();
  });

  it('accepte une commande valide DAY_RANGE', () => {
    expect(
      validateCommand(
        validCommand({
          intent: {
            kind: 'DAY_RANGE',
            startDate: '2026-03-10',
            endDateExclusive: '2026-03-13',
          },
        }),
      ),
    ).toBeNull();
  });

  it('accepte une commande avec logicalLineId', () => {
    expect(
      validateCommand(
        validCommand({
          desiredLines: [{ logicalLineId: VALID_UUID_3, variantId: VALID_UUID_2, quantity: 2 }],
        }),
      ),
    ).toBeNull();
  });

  it('rejette bookingId non-UUID', () => {
    expect(validateCommand(validCommand({ bookingId: 'not-a-uuid' }))).toMatch(
      /bookingId invalide/,
    );
  });

  it('rejette expectedLastAppliedAmendmentNumber négatif', () => {
    expect(validateCommand(validCommand({ expectedLastAppliedAmendmentNumber: -1 }))).toMatch(
      />= 0/,
    );
  });

  it('rejette expectedLastAppliedAmendmentNumber non-entier', () => {
    expect(validateCommand(validCommand({ expectedLastAppliedAmendmentNumber: 1.5 }))).toMatch(
      /entier sûr/,
    );
  });

  it('rejette TIME_RANGE avec startAt invalide', () => {
    expect(
      validateCommand(
        validCommand({
          intent: { kind: 'TIME_RANGE', startAt: 'invalid-date', endAt: '2026-03-12T17:00:00' },
        }),
      ),
    ).toMatch(/chaîne de date\+heure locale invalide/);
  });

  it('rejette TIME_RANGE avec endAt <= startAt', () => {
    expect(
      validateCommand(
        validCommand({
          intent: {
            kind: 'TIME_RANGE',
            startAt: '2026-03-12T17:00:00',
            endAt: '2026-03-10T09:00:00',
          },
        }),
      ),
    ).toMatch(/strictement après/);
  });

  it('rejette DAY_RANGE avec endDateExclusive <= startDate', () => {
    expect(
      validateCommand(
        validCommand({
          intent: {
            kind: 'DAY_RANGE',
            startDate: '2026-03-12',
            endDateExclusive: '2026-03-10',
          },
        }),
      ),
    ).toMatch(/strictement après/);
  });

  it('rejette idempotencyKey vide', () => {
    expect(validateCommand(validCommand({ idempotencyKey: '' }))).toMatch(/idempotencyKey requis/);
  });

  it('rejette desiredLines vide', () => {
    expect(validateCommand(validCommand({ desiredLines: [] }))).toMatch(/desiredLines.*non vide/);
  });

  it('rejette variantId non-UUID', () => {
    expect(
      validateCommand(validCommand({ desiredLines: [{ variantId: 'bad', quantity: 1 }] })),
    ).toMatch(/variantId invalide/);
  });

  it('rejette logicalLineId non-UUID', () => {
    expect(
      validateCommand(
        validCommand({
          desiredLines: [{ logicalLineId: 'bad', variantId: VALID_UUID_2, quantity: 1 }],
        }),
      ),
    ).toMatch(/logicalLineId invalide/);
  });

  it('rejette quantity <= 0', () => {
    expect(
      validateCommand(validCommand({ desiredLines: [{ variantId: VALID_UUID_2, quantity: 0 }] })),
    ).toMatch(/quantity.*strictement positif/);
  });

  it('rejette logicalLineId en double', () => {
    expect(
      validateCommand(
        validCommand({
          desiredLines: [
            { logicalLineId: VALID_UUID_3, variantId: VALID_UUID_2, quantity: 1 },
            { logicalLineId: VALID_UUID_3, variantId: VALID_UUID_2, quantity: 2 },
          ],
        }),
      ),
    ).toMatch(/logicalLineId en double/);
  });

  it('rejette variantId en double dans desiredLines', () => {
    expect(
      validateCommand(
        validCommand({
          desiredLines: [
            { variantId: VALID_UUID_2, quantity: 1 },
            { variantId: VALID_UUID_2, quantity: 2 },
          ],
        }),
      ),
    ).toMatch(/variantId en double/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeAmendmentFingerprint
// ─────────────────────────────────────────────────────────────────────────────

describe('computeAmendmentFingerprint', () => {
  it('produit un SHA-256 hex64', () => {
    const fp = computeAmendmentFingerprint(validCommand());
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("est indépendant de l'ordre des desiredLines", () => {
    const cmd1 = validCommand({
      desiredLines: [
        { variantId: VALID_UUID_2, quantity: 1 },
        { variantId: VALID_UUID_3, quantity: 2 },
      ],
    });
    const cmd2 = validCommand({
      desiredLines: [
        { variantId: VALID_UUID_3, quantity: 2 },
        { variantId: VALID_UUID_2, quantity: 1 },
      ],
    });
    expect(computeAmendmentFingerprint(cmd1)).toBe(computeAmendmentFingerprint(cmd2));
  });

  it('est déterministe pour la même commande', () => {
    const cmd = validCommand();
    expect(computeAmendmentFingerprint(cmd)).toBe(computeAmendmentFingerprint(cmd));
  });

  it('diffère si la quantité change', () => {
    const cmd1 = validCommand({ desiredLines: [{ variantId: VALID_UUID_2, quantity: 1 }] });
    const cmd2 = validCommand({ desiredLines: [{ variantId: VALID_UUID_2, quantity: 2 }] });
    expect(computeAmendmentFingerprint(cmd1)).not.toBe(computeAmendmentFingerprint(cmd2));
  });

  it("diffère si l'intent change", () => {
    const cmd1 = validCommand({
      intent: { kind: 'TIME_RANGE', startAt: '2026-03-10T09:00:00', endAt: '2026-03-12T17:00:00' },
    });
    const cmd2 = validCommand({
      intent: { kind: 'TIME_RANGE', startAt: '2026-03-11T09:00:00', endAt: '2026-03-12T17:00:00' },
    });
    expect(computeAmendmentFingerprint(cmd1)).not.toBe(computeAmendmentFingerprint(cmd2));
  });

  it('diffère si expectedLastAppliedAmendmentNumber change', () => {
    const cmd1 = validCommand({ expectedLastAppliedAmendmentNumber: 0 });
    const cmd2 = validCommand({ expectedLastAppliedAmendmentNumber: 1 });
    expect(computeAmendmentFingerprint(cmd1)).not.toBe(computeAmendmentFingerprint(cmd2));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeLineDiff
// ─────────────────────────────────────────────────────────────────────────────

function makeEffectiveLine(
  id: string,
  logicalLineId: string,
  variantId: string,
  quantity: number,
  unitPrice = 5000,
  originType: 'ORIGINAL' | 'AMENDMENT' = 'ORIGINAL',
  sourceBookingLineId: string | null = id,
): EffectiveLine {
  return {
    id,
    logicalLineId,
    variantId,
    action: 'UNCHANGED',
    originType,
    sourceBookingLineId,
    quantity,
    unitPriceAmountMinor: unitPrice,
    lineTotalAmountMinor: quantity * unitPrice,
    variantSnapshot: { name: 'Standard' },
  };
}

describe('computeLineDiff', () => {
  it('UNCHANGED quand même quantité avec logicalLineId fourni', () => {
    const effLines = [makeEffectiveLine('line-1', 'llid-1', VALID_UUID_2, 1)];
    const desired: NeutralAmendmentDesiredLine[] = [
      { logicalLineId: 'llid-1', variantId: VALID_UUID_2, quantity: 1 },
    ];
    const diff = computeLineDiff(effLines, desired);
    expect(diff).toHaveLength(1);
    expect(diff[0]!.action).toBe('UNCHANGED');
    expect(diff[0]!.originType).toBe('ORIGINAL');
    expect(diff[0]!.sourceBookingLineId).toBe('line-1');
    expect(diff[0]!.beforeQuantity).toBe(1);
    expect(diff[0]!.afterQuantity).toBe(1);
  });

  it('MODIFY quand quantité change avec logicalLineId fourni', () => {
    const effLines = [makeEffectiveLine('line-1', 'llid-1', VALID_UUID_2, 1)];
    const desired: NeutralAmendmentDesiredLine[] = [
      { logicalLineId: 'llid-1', variantId: VALID_UUID_2, quantity: 3 },
    ];
    const diff = computeLineDiff(effLines, desired);
    expect(diff).toHaveLength(1);
    expect(diff[0]!.action).toBe('MODIFY');
    expect(diff[0]!.beforeQuantity).toBe(1);
    expect(diff[0]!.afterQuantity).toBe(3);
  });

  it('REMOVE quand ligne effective non présente dans desiredLines', () => {
    const effLines = [makeEffectiveLine('line-1', 'llid-1', VALID_UUID_2, 1)];
    const desired: NeutralAmendmentDesiredLine[] = [{ variantId: VALID_UUID_3, quantity: 1 }];
    const diff = computeLineDiff(effLines, desired);
    const removeEntry = diff.find((d) => d.action === 'REMOVE');
    expect(removeEntry).toBeDefined();
    expect(removeEntry!.variantId).toBe(VALID_UUID_2);
    expect(removeEntry!.beforeQuantity).toBe(1);
    expect(removeEntry!.afterQuantity).toBe(0);
  });

  it('ADD pour une nouvelle ligne sans logicalLineId', () => {
    const effLines: EffectiveLine[] = [];
    const desired: NeutralAmendmentDesiredLine[] = [{ variantId: VALID_UUID_2, quantity: 2 }];
    const diff = computeLineDiff(effLines, desired);
    expect(diff).toHaveLength(1);
    expect(diff[0]!.action).toBe('ADD');
    expect(diff[0]!.originType).toBe('AMENDMENT');
    expect(diff[0]!.sourceBookingLineId).toBeNull();
    expect(diff[0]!.beforeQuantity).toBe(0);
    expect(diff[0]!.afterQuantity).toBe(2);
    expect(diff[0]!.logicalLineId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("lève INVALID_INPUT pour un logicalLineId fourni mais inexistant dans l'état effectif", () => {
    const effLines: EffectiveLine[] = [];
    const desired: NeutralAmendmentDesiredLine[] = [
      { logicalLineId: VALID_UUID_3, variantId: VALID_UUID_2, quantity: 1 },
    ];
    expect(() => computeLineDiff(effLines, desired)).toThrow();
  });

  it('lève INVALID_INPUT si logicalLineId existe mais variantId ne correspond pas', () => {
    const effLines = [makeEffectiveLine('line-1', 'llid-1', VALID_UUID_2, 1)];
    const desired: NeutralAmendmentDesiredLine[] = [
      { logicalLineId: 'llid-1', variantId: VALID_UUID_3, quantity: 1 },
    ];
    expect(() => computeLineDiff(effLines, desired)).toThrow();
  });

  it('lève INVALID_INPUT si nouvelle ligne sans logicalLineId réutilise un variantId effectif', () => {
    const effLines = [makeEffectiveLine('line-1', 'llid-1', VALID_UUID_2, 1)];
    const desired: NeutralAmendmentDesiredLine[] = [
      { variantId: VALID_UUID_2, quantity: 2 }, // réutilise VALID_UUID_2 sans logicalLineId
    ];
    expect(() => computeLineDiff(effLines, desired)).toThrow();
  });

  it("préserve originType et sourceBookingLineId pour une ligne issue d'un amendement précédent", () => {
    const effLines = [
      makeEffectiveLine('amend-line-1', 'logical-2', VALID_UUID_2, 2, 5000, 'AMENDMENT', null),
    ];
    const desired: NeutralAmendmentDesiredLine[] = [
      { logicalLineId: 'logical-2', variantId: VALID_UUID_2, quantity: 4 },
    ];
    const diff = computeLineDiff(effLines, desired);
    expect(diff).toHaveLength(1);
    expect(diff[0]!.action).toBe('MODIFY');
    expect(diff[0]!.originType).toBe('AMENDMENT');
    expect(diff[0]!.sourceBookingLineId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyDelta
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyDelta', () => {
  it('NEUTRAL pour delta === 0', () => {
    expect(classifyDelta(0)).toBe('NEUTRAL');
  });

  it('REFUND pour delta < 0', () => {
    expect(classifyDelta(-100)).toBe('REFUND');
    expect(classifyDelta(-1)).toBe('REFUND');
  });

  it('SUPPLEMENT pour delta > 0', () => {
    expect(classifyDelta(100)).toBe('SUPPLEMENT');
    expect(classifyDelta(1)).toBe('SUPPLEMENT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NeutralAmendmentError
// ─────────────────────────────────────────────────────────────────────────────

describe('NeutralAmendmentError', () => {
  it('a un code et un message', () => {
    const err = new NeutralAmendmentError('VALIDATION', 'test message');
    expect(err.code).toBe('VALIDATION');
    expect(err.message).toBe('test message');
    expect(err.name).toBe('NeutralAmendmentError');
  });

  it('est une instance de Error', () => {
    const err = new NeutralAmendmentError('INTERNAL', 'oops');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('isNeutralAmendmentErrorCode', () => {
  it('accepte les codes valides', () => {
    expect(isNeutralAmendmentErrorCode('VALIDATION')).toBe(true);
    expect(isNeutralAmendmentErrorCode('INTERNAL')).toBe(true);
  });

  it('rejette les codes invalides', () => {
    expect(isNeutralAmendmentErrorCode('INVALID')).toBe(false);
    expect(isNeutralAmendmentErrorCode(123)).toBe(false);
    expect(isNeutralAmendmentErrorCode(null)).toBe(false);
  });
});
