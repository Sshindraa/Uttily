import { describe, it, expect } from 'vitest';
import {
  FakeDeterministicDocumentRenderer,
  FAKE_TEMPLATE_KEYS,
} from './fake-deterministic-document-renderer';
import { DocumentRenderError } from './errors';
import type { DocumentRenderSnapshotV1 } from './snapshot-types';

const VALID_UUID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const VALID_UUID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const VALID_UUID_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const VALID_UUID_D = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

function makeValidSnapshot(): DocumentRenderSnapshotV1 {
  return {
    snapshotVersion: 'v1',
    sourceOutboxEventId: VALID_UUID_A,
    organizationId: VALID_UUID_B,
    bookingId: VALID_UUID_C,
    paymentId: VALID_UUID_D,
    draftId: VALID_UUID_A,
    capturedAt: '2026-01-15T10:00:00.000Z',
    organization: {
      id: VALID_UUID_B,
      legalName: 'Test Org',
    },
    location: {
      id: VALID_UUID_A,
      name: 'Annecy',
      addressLine1: '1 rue du Lac',
      addressLine2: null,
      city: 'Annecy',
      postalCode: '74000',
      countryCode: 'FR',
      timeZone: 'Europe/Paris',
    },
    customer: {
      userId: VALID_UUID_A,
      displayName: 'Jean Dupont',
      locale: 'fr',
    },
    booking: {
      id: VALID_UUID_C,
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
      id: VALID_UUID_D,
      status: 'SUCCEEDED',
      succeededAt: '2026-01-15T09:58:00.000Z',
      amountMinor: 10000,
      currency: 'EUR',
      financialTermsVersion: 'v1',
      legalTermsVersion: 'v1',
    },
    lines: [
      {
        lineId: VALID_UUID_A,
        variantId: VALID_UUID_B,
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
        bookingItemId: VALID_UUID_A,
        bookingLineId: VALID_UUID_A,
        inventoryItemId: VALID_UUID_A,
        internalSku: 'KAY-001',
        serialNumber: 'SN-001',
        condition: 'GOOD',
        inventoryStatus: 'ACTIVE',
      },
    ],
  };
}

describe('FakeDeterministicDocumentRenderer', () => {
  it('template inconnu — rejete avec VALIDATION', async () => {
    const renderer = new FakeDeterministicDocumentRenderer();
    await expect(renderer.render('unknown-template', makeValidSnapshot())).rejects.toThrow(
      DocumentRenderError,
    );
    try {
      await renderer.render('unknown-template', makeValidSnapshot());
    } catch (e) {
      expect((e as DocumentRenderError).code).toBe('VALIDATION');
    }
  });

  it('snapshot invalide (null) — rejete avec VALIDATION', async () => {
    const renderer = new FakeDeterministicDocumentRenderer();
    await expect(
      renderer.render(
        'booking-confirmation-technical-v1',
        null as unknown as DocumentRenderSnapshotV1,
      ),
    ).rejects.toThrow(DocumentRenderError);
  });

  it('snapshot invalide (mauvaise version) — rejete avec VALIDATION', async () => {
    const renderer = new FakeDeterministicDocumentRenderer();
    const bad = {
      ...makeValidSnapshot(),
      snapshotVersion: 'v2',
    } as unknown as DocumentRenderSnapshotV1;
    await expect(renderer.render('booking-confirmation-technical-v1', bad)).rejects.toThrow(
      DocumentRenderError,
    );
  });

  it('determinisme exact : memes inputs -> memes bytes/checksum/taille', async () => {
    const renderer = new FakeDeterministicDocumentRenderer();
    const snapshot = makeValidSnapshot();
    const r1 = await renderer.render('booking-confirmation-technical-v1', snapshot);
    const r2 = await renderer.render('booking-confirmation-technical-v1', snapshot);
    expect(r1.checksumSha256).toBe(r2.checksumSha256);
    expect(r1.sizeBytes).toBe(r2.sizeBytes);
    expect(Array.from(r1.content)).toEqual(Array.from(r2.content));
  });

  it('templates differents -> bytes/checksum differents', async () => {
    const renderer = new FakeDeterministicDocumentRenderer();
    const snapshot = makeValidSnapshot();
    const r1 = await renderer.render('booking-confirmation-technical-v1', snapshot);
    const r2 = await renderer.render('rental-contract-technical-v1', snapshot);
    expect(r1.checksumSha256).not.toBe(r2.checksumSha256);
    expect(r1.sizeBytes).not.toBe(r2.sizeBytes);
  });

  it('checksum SHA-256 minuscule 64 hex chars', async () => {
    const renderer = new FakeDeterministicDocumentRenderer();
    const r = await renderer.render('booking-confirmation-technical-v1', makeValidSnapshot());
    expect(r.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sizeBytes UTF-8 exact', async () => {
    const renderer = new FakeDeterministicDocumentRenderer();
    const r = await renderer.render('booking-confirmation-technical-v1', makeValidSnapshot());
    expect(r.sizeBytes).toBe(r.content.length);
    // Verifier que le contenu decode correspond au header + JSON canonique
    const decoded = new TextDecoder().decode(r.content);
    expect(decoded.startsWith('template:booking-confirmation-technical-v1\n')).toBe(true);
  });

  it('aucun email ni secret ajoute au rendu', async () => {
    const renderer = new FakeDeterministicDocumentRenderer();
    const r = await renderer.render('booking-confirmation-technical-v1', makeValidSnapshot());
    const decoded = new TextDecoder().decode(r.content);
    // Le snapshot ne contient pas recipientEmail, client_secret, etc.
    expect(decoded).not.toContain('recipientEmail');
    expect(decoded).not.toContain('client_secret');
    expect(decoded).not.toContain('email');
    // Le snapshot ne contient pas non plus ces champs dans sa structure
    const snapshot = makeValidSnapshot();
    const snapshotJson = JSON.stringify(snapshot);
    expect(snapshotJson).not.toContain('recipientEmail');
    expect(snapshotJson).not.toContain('client_secret');
  });

  it('champs internes absents du rendu (commissionAmountMinor, connectedAccountId, environment)', async () => {
    const renderer = new FakeDeterministicDocumentRenderer();
    const r = await renderer.render('booking-confirmation-technical-v1', makeValidSnapshot());
    const decoded = new TextDecoder().decode(r.content);
    expect(decoded).not.toContain('commissionAmountMinor');
    expect(decoded).not.toContain('connectedAccountId');
    expect(decoded).not.toContain('environment');
  });

  it('snapshot avec commissionAmountMinor interdit — rejete (parser central)', async () => {
    const renderer = new FakeDeterministicDocumentRenderer();
    const bad = {
      ...makeValidSnapshot(),
      booking: { ...makeValidSnapshot().booking, commissionAmountMinor: 500 },
    } as unknown as DocumentRenderSnapshotV1;
    await expect(renderer.render('booking-confirmation-technical-v1', bad)).rejects.toThrow(
      DocumentRenderError,
    );
  });

  it('snapshot avec connectedAccountId interdit — rejete (parser central)', async () => {
    const renderer = new FakeDeterministicDocumentRenderer();
    const bad = {
      ...makeValidSnapshot(),
      payment: { ...makeValidSnapshot().payment, connectedAccountId: 'acct_x' },
    } as unknown as DocumentRenderSnapshotV1;
    await expect(renderer.render('booking-confirmation-technical-v1', bad)).rejects.toThrow(
      DocumentRenderError,
    );
  });

  it('contentType technique explicite', async () => {
    const renderer = new FakeDeterministicDocumentRenderer();
    const r = await renderer.render('booking-confirmation-technical-v1', makeValidSnapshot());
    expect(r.contentType).toBe('application/vnd.uttily.test-document+json');
  });

  it('FAKE_TEMPLATE_KEYS contient exactement 3 cles techniques', () => {
    expect(FAKE_TEMPLATE_KEYS).toHaveLength(3);
    expect(FAKE_TEMPLATE_KEYS.every((k) => k.includes('technical'))).toBe(true);
  });

  it('snapshot avec champs manquants — rejete', async () => {
    const renderer = new FakeDeterministicDocumentRenderer();
    const bad = { ...makeValidSnapshot(), organizationId: '' };
    await expect(renderer.render('booking-confirmation-technical-v1', bad)).rejects.toThrow(
      DocumentRenderError,
    );
  });

  it('snapshot avec UUID invalide — rejete', async () => {
    const renderer = new FakeDeterministicDocumentRenderer();
    const bad = { ...makeValidSnapshot(), bookingId: 'not-a-uuid' };
    await expect(renderer.render('booking-confirmation-technical-v1', bad)).rejects.toThrow(
      DocumentRenderError,
    );
  });

  it('snapshot avec lines non-tableau — rejete', async () => {
    const renderer = new FakeDeterministicDocumentRenderer();
    const bad = {
      ...makeValidSnapshot(),
      lines: 'not-an-array',
    } as unknown as DocumentRenderSnapshotV1;
    await expect(renderer.render('booking-confirmation-technical-v1', bad)).rejects.toThrow(
      DocumentRenderError,
    );
  });
});
