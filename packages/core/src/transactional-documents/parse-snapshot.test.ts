import { describe, it, expect } from 'vitest';
import { parseDocumentRenderSnapshotV1 } from './parse-snapshot';
import { DocumentRenderError } from './errors';

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const D = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const E = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

/** Snapshot mutable pour les tests (permet de corrompre les champs). */
interface MutableSnapshot {
  snapshotVersion: string;
  sourceOutboxEventId: string;
  organizationId: string;
  bookingId: string;
  paymentId: string;
  draftId: string;
  capturedAt: string;
  organization: { id: string; legalName: string; [k: string]: unknown };
  location: {
    id: string;
    name: string;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    postalCode: string | null;
    countryCode: string | null;
    timeZone: string;
    [k: string]: unknown;
  };
  customer: { userId: string; displayName: string | null; locale: string; [k: string]: unknown };
  booking: {
    id: string;
    status: string;
    customerStartAt: string;
    customerEndAt: string;
    confirmedAt: string;
    prepBufferMinutes: number;
    cleanupBufferMinutes: number;
    currency: string;
    subtotalAmountMinor: number;
    mandatoryFeesAmountMinor: number;
    totalAmountMinor: number;
    taxStatus: string;
    taxAmountMinor: number | null;
    taxRateBps: number | null;
    cancellationPolicySnapshot: Record<string, unknown>;
    termsAcceptanceSnapshot: Record<string, unknown>;
    [k: string]: unknown;
  };
  payment: {
    id: string;
    status: string;
    succeededAt: string;
    amountMinor: number;
    currency: string;
    financialTermsVersion: string;
    legalTermsVersion: string;
    [k: string]: unknown;
  };
  lines: Array<{
    lineId: string;
    variantId: string;
    quantity: number;
    unitPriceAmountMinor: number;
    billableUnitCount: number;
    lineTotalAmountMinor: number;
    currency: string;
    variantSnapshot: Record<string, unknown>;
    [k: string]: unknown;
  }>;
  items: Array<{
    bookingItemId: string;
    bookingLineId: string;
    inventoryItemId: string;
    internalSku: string;
    serialNumber: string | null;
    condition: string;
    inventoryStatus: string;
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
}

function baseSnapshot(): MutableSnapshot {
  return {
    snapshotVersion: 'v1',
    sourceOutboxEventId: A,
    organizationId: B,
    bookingId: C,
    paymentId: D,
    draftId: E,
    capturedAt: '2026-01-15T10:00:00.000Z',
    organization: { id: B, legalName: 'Test Org' },
    location: {
      id: A,
      name: 'Annecy',
      addressLine1: '1 rue du Lac',
      addressLine2: null,
      city: 'Annecy',
      postalCode: '74000',
      countryCode: 'FR',
      timeZone: 'Europe/Paris',
    },
    customer: { userId: A, displayName: 'Jean Dupont', locale: 'fr' },
    booking: {
      id: C,
      status: 'CONFIRMED',
      customerStartAt: '2026-02-10T09:00:00.000Z',
      customerEndAt: '2026-02-12T17:00:00.000Z',
      confirmedAt: '2026-01-15T10:00:00.000Z',
      prepBufferMinutes: 30,
      cleanupBufferMinutes: 30,
      currency: 'EUR',
      subtotalAmountMinor: 10000,
      mandatoryFeesAmountMinor: 0,
      totalAmountMinor: 10000,
      taxStatus: 'NOT_APPLICABLE',
      taxAmountMinor: 0,
      taxRateBps: null,
      cancellationPolicySnapshot: { policy_code: 'FLEXIBLE' },
      termsAcceptanceSnapshot: { version: 'v1' },
    },
    payment: {
      id: D,
      status: 'SUCCEEDED',
      succeededAt: '2026-01-15T09:58:00.000Z',
      amountMinor: 10000,
      currency: 'EUR',
      financialTermsVersion: 'v1',
      legalTermsVersion: 'v1',
    },
    lines: [
      {
        lineId: A,
        variantId: B,
        quantity: 2,
        unitPriceAmountMinor: 5000,
        billableUnitCount: 2,
        lineTotalAmountMinor: 10000,
        currency: 'EUR',
        variantSnapshot: { name: 'Standard' },
      },
    ],
    items: [
      {
        bookingItemId: A,
        bookingLineId: A,
        inventoryItemId: A,
        internalSku: 'KAY-001',
        serialNumber: 'SN-001',
        condition: 'GOOD',
        inventoryStatus: 'ACTIVE',
      },
    ],
  };
}

function expectInvariant(snapshot: unknown): void {
  expect(() => parseDocumentRenderSnapshotV1(snapshot)).toThrow(DocumentRenderError);
  try {
    parseDocumentRenderSnapshotV1(snapshot);
  } catch (e) {
    expect((e as DocumentRenderError).code).toBe('SNAPSHOT_INVARIANT');
  }
}

function expectValidation(snapshot: unknown): void {
  expect(() => parseDocumentRenderSnapshotV1(snapshot)).toThrow(DocumentRenderError);
  try {
    parseDocumentRenderSnapshotV1(snapshot);
  } catch (e) {
    expect((e as DocumentRenderError).code).toBe('VALIDATION');
  }
}

describe('parseDocumentRenderSnapshotV1', () => {
  // nominal
  it('nominal — snapshot valide accepte', () => {
    const result = parseDocumentRenderSnapshotV1(baseSnapshot());
    expect(result.snapshotVersion).toBe('v1');
    expect(result.booking.id).toBe(C);
    expect(result.lines).toHaveLength(1);
    expect(result.items).toHaveLength(1);
  });

  // racine non-objet
  it('racine null — SNAPSHOT_INVARIANT', () => expectInvariant(null));
  it('racine array — SNAPSHOT_INVARIANT', () => expectInvariant([]));
  it('racine string — SNAPSHOT_INVARIANT', () => expectInvariant('hello'));

  // extra keys racine
  it('racine cle supplementaire — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot() as Record<string, unknown>;
    s['extra'] = 'bad';
    expectInvariant(s);
  });

  // snapshotVersion
  it('snapshotVersion v2 — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    (s as unknown as Record<string, unknown>)['snapshotVersion'] = 'v2';
    expectInvariant(s);
  });

  // UUIDs invalides racine
  it('sourceOutboxEventId non-UUID — VALIDATION', () => {
    const s = baseSnapshot();
    (s as unknown as Record<string, unknown>)['sourceOutboxEventId'] = 'not-a-uuid';
    expectValidation(s);
  });
  it('organizationId non-UUID — VALIDATION', () => {
    const s = baseSnapshot();
    (s as unknown as Record<string, unknown>)['organizationId'] = 'not-a-uuid';
    expectValidation(s);
  });
  it('bookingId non-UUID — VALIDATION', () => {
    const s = baseSnapshot();
    (s as unknown as Record<string, unknown>)['bookingId'] = 'not-a-uuid';
    expectValidation(s);
  });
  it('paymentId non-UUID — VALIDATION', () => {
    const s = baseSnapshot();
    (s as unknown as Record<string, unknown>)['paymentId'] = 'not-a-uuid';
    expectValidation(s);
  });
  it('draftId non-UUID — VALIDATION', () => {
    const s = baseSnapshot();
    (s as unknown as Record<string, unknown>)['draftId'] = 'not-a-uuid';
    expectValidation(s);
  });

  // capturedAt non canonique
  it('capturedAt avec offset — VALIDATION', () => {
    const s = baseSnapshot();
    (s as unknown as Record<string, unknown>)['capturedAt'] = '2026-01-15T10:00:00+02:00';
    expectValidation(s);
  });
  it('capturedAt format non-ISO — VALIDATION', () => {
    const s = baseSnapshot();
    (s as unknown as Record<string, unknown>)['capturedAt'] = '2026/01/15 10:00';
    expectValidation(s);
  });
  it('capturedAt date impossible — VALIDATION', () => {
    const s = baseSnapshot();
    (s as unknown as Record<string, unknown>)['capturedAt'] = '2026-13-45T99:99:99.999Z';
    expectValidation(s);
  });

  // Cohérences racine ↔ sous-objets
  it('organization.id !== organizationId — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.organization = { ...s.organization, id: C };
    expectInvariant(s);
  });
  it('booking.id !== bookingId — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.booking = { ...s.booking, id: B };
    expectInvariant(s);
  });
  it('payment.id !== paymentId — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.payment = { ...s.payment, id: B };
    expectInvariant(s);
  });

  // organization extra key
  it('organization cle supplementaire — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.organization = { ...s.organization, extra: 'bad' } as unknown as typeof s.organization;
    expectInvariant(s);
  });
  it('organization.id non-UUID — VALIDATION', () => {
    const s = baseSnapshot();
    s.organization = { ...s.organization, id: 'bad' };
    expectValidation(s);
  });
  it('organization.legalName vide — VALIDATION', () => {
    const s = baseSnapshot();
    s.organization = { ...s.organization, legalName: '' };
    expectValidation(s);
  });

  // location extra key
  it('location cle supplementaire — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.location = { ...s.location, extra: 'bad' } as unknown as typeof s.location;
    expectInvariant(s);
  });
  it('location.timeZone invalide — VALIDATION', () => {
    const s = baseSnapshot();
    s.location = { ...s.location, timeZone: 'Invalid/Zone' };
    expectValidation(s);
  });

  // customer extra key (email interdit)
  it('customer avec email — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.customer = { ...s.customer, email: 'a@b.com' } as unknown as typeof s.customer;
    expectInvariant(s);
  });
  it('customer cle supplementaire non interdite — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.customer = { ...s.customer, extra: 'bad' } as unknown as typeof s.customer;
    expectInvariant(s);
  });

  // booking extra key / champs interdits
  it('booking avec commissionAmountMinor — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.booking = { ...s.booking, commissionAmountMinor: 500 } as unknown as typeof s.booking;
    expectInvariant(s);
  });
  it('booking avec commissionRuleSnapshot — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.booking = { ...s.booking, commissionRuleSnapshot: {} } as unknown as typeof s.booking;
    expectInvariant(s);
  });
  it('booking avec taxRuleSnapshot — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.booking = { ...s.booking, taxRuleSnapshot: {} } as unknown as typeof s.booking;
    expectInvariant(s);
  });
  it('booking.status enum invalide — VALIDATION', () => {
    const s = baseSnapshot();
    s.booking = { ...s.booking, status: 'INVALID_STATUS' };
    expectValidation(s);
  });
  it('booking.customerStartAt >= customerEndAt — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.booking = {
      ...s.booking,
      customerStartAt: '2026-02-12T17:00:00.000Z',
      customerEndAt: '2026-02-12T17:00:00.000Z',
    };
    expectInvariant(s);
  });
  it('booking.customerStartAt non canonique — VALIDATION', () => {
    const s = baseSnapshot();
    s.booking = { ...s.booking, customerStartAt: '2026-02-10T09:00:00+02:00' };
    expectValidation(s);
  });
  it('booking.prepBufferMinutes = 0 accepte', () => {
    const s = baseSnapshot();
    s.booking = { ...s.booking, prepBufferMinutes: 0 };
    expect(parseDocumentRenderSnapshotV1(s).booking.prepBufferMinutes).toBe(0);
  });
  it('booking.prepBufferMinutes = -1 — VALIDATION', () => {
    const s = baseSnapshot();
    s.booking = { ...s.booking, prepBufferMinutes: -1 };
    expectValidation(s);
  });
  it('booking.cleanupBufferMinutes = 0 accepte', () => {
    const s = baseSnapshot();
    s.booking = { ...s.booking, cleanupBufferMinutes: 0 };
    expect(parseDocumentRenderSnapshotV1(s).booking.cleanupBufferMinutes).toBe(0);
  });
  it('booking.cleanupBufferMinutes = -1 — VALIDATION', () => {
    const s = baseSnapshot();
    s.booking = { ...s.booking, cleanupBufferMinutes: -1 };
    expectValidation(s);
  });
  it('booking.subtotalAmountMinor negatif — VALIDATION', () => {
    const s = baseSnapshot();
    s.booking = { ...s.booking, subtotalAmountMinor: -1 };
    expectValidation(s);
  });
  it('booking.taxStatus enum invalide — VALIDATION', () => {
    const s = baseSnapshot();
    s.booking = { ...s.booking, taxStatus: 'INVALID' };
    expectValidation(s);
  });

  // payment extra key / champs interdits
  it('payment avec connectedAccountId — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.payment = { ...s.payment, connectedAccountId: 'acct_x' } as unknown as typeof s.payment;
    expectInvariant(s);
  });
  it('payment avec environment — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.payment = { ...s.payment, environment: 'TEST' } as unknown as typeof s.payment;
    expectInvariant(s);
  });
  it('payment avec onBehalfOfAccountId — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.payment = { ...s.payment, onBehalfOfAccountId: A } as unknown as typeof s.payment;
    expectInvariant(s);
  });
  it('payment avec client_secret — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.payment = { ...s.payment, client_secret: 'sec_x' } as unknown as typeof s.payment;
    expectInvariant(s);
  });
  it('payment.status non SUCCEEDED — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.payment = { ...s.payment, status: 'FAILED' };
    expectInvariant(s);
  });
  it('payment.currency !== booking.currency — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.payment = { ...s.payment, currency: 'USD' };
    expectInvariant(s);
  });
  it('payment.amountMinor unsafe — VALIDATION', () => {
    const s = baseSnapshot();
    s.payment = { ...s.payment, amountMinor: Number.MAX_SAFE_INTEGER + 1 };
    expectValidation(s);
  });

  // lines
  it('lines vide — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    (s as unknown as Record<string, unknown>)['lines'] = [];
    expectInvariant(s);
  });
  it('lines non-tableau — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    (s as unknown as Record<string, unknown>)['lines'] = 'not-an-array';
    expectInvariant(s);
  });
  it('lines[0] cle supplementaire — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.lines = [{ ...s.lines[0]!, extra: 'bad' } as unknown as (typeof s.lines)[number]];
    expectInvariant(s);
  });
  it('lines[0].lineId non-UUID — VALIDATION', () => {
    const s = baseSnapshot();
    s.lines = [{ ...s.lines[0]!, lineId: 'bad' }];
    expectValidation(s);
  });
  it('lines[0].quantity <= 0 — VALIDATION', () => {
    const s = baseSnapshot();
    s.lines = [{ ...s.lines[0]!, quantity: 0 }];
    expectValidation(s);
  });
  it('lines[0].billableUnitCount <= 0 — VALIDATION', () => {
    const s = baseSnapshot();
    s.lines = [{ ...s.lines[0]!, billableUnitCount: 0 }];
    expectValidation(s);
  });
  it('lines[0].lineTotalAmountMinor negatif — VALIDATION', () => {
    const s = baseSnapshot();
    s.lines = [{ ...s.lines[0]!, lineTotalAmountMinor: -1 }];
    expectValidation(s);
  });
  it('lines[0].currency !== booking.currency — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.lines = [{ ...s.lines[0]!, currency: 'USD' }];
    expectInvariant(s);
  });
  it('lines non trie par lineId — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    // Ajouter une ligne avec un lineId < A (lexicalement)
    const smaller = '00000000-0000-0000-0000-000000000001';
    s.lines = [
      { ...s.lines[0]!, lineId: A },
      { ...s.lines[0]!, lineId: smaller },
    ];
    expectInvariant(s);
  });
  it('lines doublon lineId — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.lines = [
      { ...s.lines[0]!, lineId: A },
      { ...s.lines[0]!, lineId: A, bookingItemId: B },
    ];
    // Fix items to reference both lines to avoid item→line error first
    s.items = [
      { ...s.items[0]!, bookingItemId: A, bookingLineId: A },
      { ...s.items[0]!, bookingItemId: B, bookingLineId: A },
    ];
    expectInvariant(s);
  });

  // items
  it('items vide — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    (s as unknown as Record<string, unknown>)['items'] = [];
    expectInvariant(s);
  });
  it('items non-tableau — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    (s as unknown as Record<string, unknown>)['items'] = 'not-an-array';
    expectInvariant(s);
  });
  it('items[0] cle supplementaire — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.items = [{ ...s.items[0]!, extra: 'bad' } as unknown as (typeof s.items)[number]];
    expectInvariant(s);
  });
  it('items[0].bookingItemId non-UUID — VALIDATION', () => {
    const s = baseSnapshot();
    s.items = [{ ...s.items[0]!, bookingItemId: 'bad' }];
    expectValidation(s);
  });
  it('items[0].condition enum invalide — VALIDATION', () => {
    const s = baseSnapshot();
    s.items = [{ ...s.items[0]!, condition: 'INVALID' }];
    expectValidation(s);
  });
  it('items[0].inventoryStatus enum invalide — VALIDATION', () => {
    const s = baseSnapshot();
    s.items = [{ ...s.items[0]!, inventoryStatus: 'INVALID' }];
    expectValidation(s);
  });
  it('items[0].bookingLineId inexistant dans lines — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.items = [{ ...s.items[0]!, bookingLineId: B }];
    expectInvariant(s);
  });
  it('items non trie par bookingItemId — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    const smaller = '00000000-0000-0000-0000-000000000001';
    s.items = [
      { ...s.items[0]!, bookingItemId: A },
      { ...s.items[0]!, bookingItemId: smaller },
    ];
    expectInvariant(s);
  });
  it('items doublon bookingItemId — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.items = [
      { ...s.items[0]!, bookingItemId: A },
      { ...s.items[0]!, bookingItemId: A },
    ];
    expectInvariant(s);
  });

  // objets JSON opaques non sérialisables
  it('cancellationPolicySnapshot avec undefined — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.booking = {
      ...s.booking,
      cancellationPolicySnapshot: {
        x: undefined,
      } as unknown as typeof s.booking.cancellationPolicySnapshot,
    };
    expectInvariant(s);
  });
  it('cancellationPolicySnapshot avec bigint — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.booking = {
      ...s.booking,
      cancellationPolicySnapshot: {
        x: 42n,
      } as unknown as typeof s.booking.cancellationPolicySnapshot,
    };
    expectInvariant(s);
  });
  it('cancellationPolicySnapshot avec Date — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.booking = {
      ...s.booking,
      cancellationPolicySnapshot: {
        x: new Date(),
      } as unknown as typeof s.booking.cancellationPolicySnapshot,
    };
    expectInvariant(s);
  });
  it('cancellationPolicySnapshot avec NaN — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.booking = {
      ...s.booking,
      cancellationPolicySnapshot: {
        x: NaN,
      } as unknown as typeof s.booking.cancellationPolicySnapshot,
    };
    expectInvariant(s);
  });
  it('cancellationPolicySnapshot avec Infinity — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.booking = {
      ...s.booking,
      cancellationPolicySnapshot: {
        x: Infinity,
      } as unknown as typeof s.booking.cancellationPolicySnapshot,
    };
    expectInvariant(s);
  });
  it('cancellationPolicySnapshot avec fonction — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.booking = {
      ...s.booking,
      cancellationPolicySnapshot: {
        x: () => 42,
      } as unknown as typeof s.booking.cancellationPolicySnapshot,
    };
    expectInvariant(s);
  });
  it('cancellationPolicySnapshot avec symbol — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.booking = {
      ...s.booking,
      cancellationPolicySnapshot: {
        x: Symbol('s'),
      } as unknown as typeof s.booking.cancellationPolicySnapshot,
    };
    expectInvariant(s);
  });
  it('cancellationPolicySnapshot avec reference circulaire — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    const cycle: Record<string, unknown> = { a: 1 };
    cycle['self'] = cycle;
    s.booking = {
      ...s.booking,
      cancellationPolicySnapshot: cycle as unknown as typeof s.booking.cancellationPolicySnapshot,
    };
    expectInvariant(s);
  });
  it('variantSnapshot avec undefined — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.lines = [
      {
        ...s.lines[0]!,
        variantSnapshot: { x: undefined } as unknown as (typeof s.lines)[number]['variantSnapshot'],
      },
    ];
    expectInvariant(s);
  });

  // recoupement somme des lignes vs sous-total
  it('somme exacte acceptee', () => {
    const s = baseSnapshot();
    // Cas nominal : une ligne avec lineTotalAmountMinor = subtotalAmountMinor = 10000
    expect(parseDocumentRenderSnapshotV1(s).booking.subtotalAmountMinor).toBe(10000);
  });
  it('somme differente du sous-total — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.lines = [{ ...s.lines[0]!, lineTotalAmountMinor: 9999 }];
    expectInvariant(s);
  });
  it('dépassement de safe integer pendant l addition — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    const max = Number.MAX_SAFE_INTEGER;
    // Deux lignes dont la somme dépasse MAX_SAFE_INTEGER.
    // Ajuster subtotalAmountMinor pour qu'il ne déclenche pas l'erreur de somme
    // avant l'overflow (on veut tester l'overflow, pas la différence de somme).
    // Mais subtotalAmountMinor doit être un safe integer, donc on ne peut pas
    // le mettre à 2*max. Le test vérifie que l'overflow est détecté avant la
    // comparaison.
    s.lines = [
      { ...s.lines[0]!, lineId: A, lineTotalAmountMinor: max },
      { ...s.lines[0]!, lineId: B, lineTotalAmountMinor: max },
    ];
    // Fix items pour référencer les deux lignes
    s.items = [
      { ...s.items[0]!, bookingItemId: A, bookingLineId: A },
      { ...s.items[0]!, bookingItemId: B, bookingLineId: B },
    ];
    expectInvariant(s);
  });

  // objets JSON opaques : Map, Set, instances de classes, prototype personnalisé
  it('variantSnapshot avec Map — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.lines = [
      {
        ...s.lines[0]!,
        variantSnapshot: new Map([
          ['a', 1],
        ]) as unknown as (typeof s.lines)[number]['variantSnapshot'],
      },
    ];
    expectInvariant(s);
  });
  it('variantSnapshot avec Set — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.lines = [
      {
        ...s.lines[0]!,
        variantSnapshot: new Set([1, 2]) as unknown as (typeof s.lines)[number]['variantSnapshot'],
      },
    ];
    expectInvariant(s);
  });
  it('variantSnapshot avec instance de classe — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    class Foo {}
    s.lines = [
      {
        ...s.lines[0]!,
        variantSnapshot: new Foo() as unknown as (typeof s.lines)[number]['variantSnapshot'],
      },
    ];
    expectInvariant(s);
  });
  it('variantSnapshot avec prototype personnalise — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.lines = [
      {
        ...s.lines[0]!,
        variantSnapshot: Object.create({
          custom: true,
        }) as unknown as (typeof s.lines)[number]['variantSnapshot'],
      },
    ];
    expectInvariant(s);
  });
  it('variantSnapshot avec objet a prototype null — accepte', () => {
    const s = baseSnapshot();
    const obj = Object.create(null);
    obj['name'] = 'Standard';
    s.lines = [
      {
        ...s.lines[0]!,
        variantSnapshot: obj as unknown as (typeof s.lines)[number]['variantSnapshot'],
      },
    ];
    expect(parseDocumentRenderSnapshotV1(s).lines[0]!.variantSnapshot).toEqual({
      name: 'Standard',
    });
  });
  it('variantSnapshot avec cycle — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    const cycle: Record<string, unknown> = { a: 1 };
    cycle['self'] = cycle;
    s.lines = [
      {
        ...s.lines[0]!,
        variantSnapshot: cycle as unknown as (typeof s.lines)[number]['variantSnapshot'],
      },
    ];
    expectInvariant(s);
  });
  it('variantSnapshot avec reference partagee non cyclique — accepte', () => {
    const s = baseSnapshot();
    const shared = { tag: 'shared' };
    s.lines = [
      {
        ...s.lines[0]!,
        variantSnapshot: {
          a: shared,
          b: shared,
        } as unknown as (typeof s.lines)[number]['variantSnapshot'],
      },
    ];
    expect(parseDocumentRenderSnapshotV1(s).lines[0]!.variantSnapshot).toEqual({
      a: { tag: 'shared' },
      b: { tag: 'shared' },
    });
  });
  it('termsAcceptanceSnapshot avec Map — SNAPSHOT_INVARIANT', () => {
    const s = baseSnapshot();
    s.booking = {
      ...s.booking,
      termsAcceptanceSnapshot: new Map([
        ['a', 1],
      ]) as unknown as typeof s.booking.termsAcceptanceSnapshot,
    };
    expectInvariant(s);
  });

  // messages d'erreur n'incluent pas les valeurs hostiles
  it('message d erreur n inclut pas la valeur hostile (booking.status)', () => {
    const s = baseSnapshot();
    s.booking = { ...s.booking, status: 'HOSTILE_VALUE_<script>' };
    try {
      parseDocumentRenderSnapshotV1(s);
      expect.fail('devrait lever');
    } catch (e) {
      const msg = (e as DocumentRenderError).message;
      expect(msg).not.toContain('HOSTILE_VALUE');
      expect(msg).not.toContain('<script>');
    }
  });
  it('message d erreur n inclut pas la valeur hostile (capturedAt)', () => {
    const s = baseSnapshot();
    (s as unknown as Record<string, unknown>)['capturedAt'] = 'HOSTILE_<script>';
    try {
      parseDocumentRenderSnapshotV1(s);
      expect.fail('devrait lever');
    } catch (e) {
      const msg = (e as DocumentRenderError).message;
      expect(msg).not.toContain('HOSTILE');
      expect(msg).not.toContain('<script>');
    }
  });

  // statuts CANCELLED et REFUNDED acceptés
  it('booking.status CANCELLED accepte', () => {
    const s = baseSnapshot();
    s.booking = { ...s.booking, status: 'CANCELLED' };
    expect(parseDocumentRenderSnapshotV1(s).booking.status).toBe('CANCELLED');
  });
  it('booking.status REFUNDED accepte', () => {
    const s = baseSnapshot();
    s.booking = { ...s.booking, status: 'REFUNDED' };
    expect(parseDocumentRenderSnapshotV1(s).booking.status).toBe('REFUNDED');
  });

  // taxStatus APPLIED avec taxAmountMinor null accepté (le parser ne croise pas)
  it('taxStatus APPLIED accepte', () => {
    const s = baseSnapshot();
    s.booking = {
      ...s.booking,
      taxStatus: 'APPLIED',
      taxAmountMinor: 2000,
      taxRateBps: 2000,
    };
    expect(parseDocumentRenderSnapshotV1(s).booking.taxStatus).toBe('APPLIED');
  });
});
