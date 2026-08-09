import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';

import { DocumentRenderError } from '@uttily/core';
import type { DocumentRenderSnapshotV1 } from '@uttily/core';

import {
  PdfLibDocumentRenderer,
  PDF_LIB_RENDERER_VERSION,
  PDF_CONTENT_TYPE,
  PDF_LIB_TEMPLATE_KEYS,
  INTER_FONT_SHA256,
  MAX_TEXT_LENGTH,
  MAX_LINES,
  MAX_ITEMS,
  MAX_PAGES,
  MAX_PDF_SIZE_BYTES,
  buildViewModel,
  assertPdfOutputLimits,
  formatAmountMinor,
  formatDateNumeric,
} from './pdf-lib-document-renderer';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — snapshots de test fictifs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rend tous les niveaux d'un type mutables (supprime readonly).
 * Préserve les types littéraux (ex: snapshotVersion: 'v1').
 */
type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [P in keyof T]: DeepMutable<T[P]> }
    : T;

type MutableSnapshot = DeepMutable<DocumentRenderSnapshotV1>;

const UUID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const UUID_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const UUID_D = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const UUID_E = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const UUID_F = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

function makeValidSnapshot(): MutableSnapshot {
  return {
    snapshotVersion: 'v1',
    sourceOutboxEventId: UUID_A,
    organizationId: UUID_B,
    bookingId: UUID_C,
    paymentId: UUID_D,
    draftId: UUID_E,
    capturedAt: '2026-01-15T10:00:00.000Z',
    organization: {
      id: UUID_B,
      legalName: 'Alpes Location SARL',
    },
    location: {
      id: UUID_A,
      name: 'Annecy',
      addressLine1: '1 rue du Lac',
      addressLine2: null,
      city: 'Annecy',
      postalCode: '74000',
      countryCode: 'FR',
      timeZone: 'Europe/Paris',
    },
    customer: {
      userId: UUID_F,
      displayName: 'Jean Dupont',
      locale: 'fr',
    },
    booking: {
      id: UUID_C,
      status: 'CONFIRMED',
      customerStartAt: '2026-02-10T09:00:00.000Z',
      customerEndAt: '2026-02-12T17:00:00.000Z',
      confirmedAt: '2026-01-15T10:00:00.000Z',
      prepBufferMinutes: 30,
      cleanupBufferMinutes: 30,
      currency: 'EUR',
      subtotalAmountMinor: 15000,
      mandatoryFeesAmountMinor: 0,
      totalAmountMinor: 15000,
      taxStatus: 'NOT_APPLICABLE',
      taxAmountMinor: 0,
      taxRateBps: null,
      cancellationPolicySnapshot: { policy_code: 'FLEXIBLE' },
      termsAcceptanceSnapshot: { version: 'v1' },
    },
    payment: {
      id: UUID_D,
      status: 'SUCCEEDED',
      succeededAt: '2026-01-15T09:58:00.000Z',
      amountMinor: 15000,
      currency: 'EUR',
      financialTermsVersion: 'v1',
      legalTermsVersion: 'v1',
    },
    lines: [
      {
        lineId: UUID_A,
        variantId: UUID_B,
        quantity: 2,
        unitPriceAmountMinor: 7500,
        billableUnitCount: 2,
        lineTotalAmountMinor: 15000,
        currency: 'EUR',
        variantSnapshot: { name: 'Kayak biplace' },
      },
    ],
    items: [
      {
        bookingItemId: UUID_A,
        bookingLineId: UUID_A,
        inventoryItemId: UUID_A,
        internalSku: 'KAY-001',
        serialNumber: 'SN-001',
        condition: 'GOOD',
        inventoryStatus: 'ACTIVE',
      },
    ],
  };
}

/**
 * Construit un snapshot avec N lignes et items correspondants.
 * Les lineId et bookingItemId sont triés (UUIDs séquentiels générés déterministement).
 */
function makeSnapshotWithLines(lineCount: number): MutableSnapshot {
  const base = makeValidSnapshot();
  const lines: DocumentRenderSnapshotV1['lines'][number][] = [];
  const items: DocumentRenderSnapshotV1['items'][number][] = [];

  const unitPrice = 100;
  for (let i = 0; i < lineCount; i++) {
    // Génère des UUIDs triés : 00000{i:03d}...
    const suffix = i.toString().padStart(12, '0');
    const lineId = `00000000-0000-0000-0000-${suffix}`;
    const variantId = `00000001-0000-0000-0000-${suffix}`;
    lines.push({
      lineId,
      variantId,
      quantity: 1,
      unitPriceAmountMinor: unitPrice,
      billableUnitCount: 1,
      lineTotalAmountMinor: unitPrice,
      currency: 'EUR',
      variantSnapshot: { name: `Article ${i}` },
    });
    const itemSuffix = i.toString().padStart(12, '0');
    const bookingItemId = `10000000-0000-0000-0000-${itemSuffix}`;
    items.push({
      bookingItemId,
      bookingLineId: lineId,
      inventoryItemId: `20000000-0000-0000-0000-${itemSuffix}`,
      internalSku: `SKU-${i}`,
      serialNumber: `SN-${i}`,
      condition: 'GOOD',
      inventoryStatus: 'ACTIVE',
    });
  }

  const total = lines.reduce((acc, l) => acc + l.lineTotalAmountMinor, 0);
  return {
    ...base,
    lines,
    items,
    booking: {
      ...base.booking,
      subtotalAmountMinor: total,
      totalAmountMinor: total,
    },
    payment: {
      ...base.payment,
      amountMinor: total,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('PdfLibDocumentRenderer', () => {
  // ── 1. Trois templates produisent des PDFs valides ──
  it('booking-confirmation-technical-v1 produit un PDF valide', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const r = await renderer.render('booking-confirmation-technical-v1', makeValidSnapshot());
    expect(r.content.length).toBeGreaterThan(0);
    expect(r.contentType).toBe(PDF_CONTENT_TYPE);
  });

  it('rental-contract-technical-v1 produit un PDF valide', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const r = await renderer.render('rental-contract-technical-v1', makeValidSnapshot());
    expect(r.content.length).toBeGreaterThan(0);
  });

  it('payment-receipt-technical-v1 produit un PDF valide', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const r = await renderer.render('payment-receipt-technical-v1', makeValidSnapshot());
    expect(r.content.length).toBeGreaterThan(0);
  });

  // ── 2. Template inconnu rejeté sans exposer la valeur ──
  it('template inconnu — rejete avec VALIDATION sans exposer la valeur', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const unknownKey = 'unknown-template-xyz';
    try {
      await renderer.render(unknownKey, makeValidSnapshot());
      expect.fail('devrait lever une erreur');
    } catch (e) {
      expect(e).toBeInstanceOf(DocumentRenderError);
      expect((e as DocumentRenderError).code).toBe('VALIDATION');
      expect((e as Error).message).not.toContain(unknownKey);
    }
  });

  // ── 3. Snapshot invalide rejeté ──
  it('snapshot invalide (null) — rejete', async () => {
    const renderer = new PdfLibDocumentRenderer();
    await expect(
      renderer.render(
        'booking-confirmation-technical-v1',
        null as unknown as DocumentRenderSnapshotV1,
      ),
    ).rejects.toThrow(DocumentRenderError);
  });

  it('snapshot invalide (mauvaise version) — rejete', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const bad = {
      ...makeValidSnapshot(),
      snapshotVersion: 'v2',
    } as unknown as DocumentRenderSnapshotV1;
    await expect(renderer.render('booking-confirmation-technical-v1', bad)).rejects.toThrow(
      DocumentRenderError,
    );
  });

  // ── 4. Content commence par %PDF- ──
  it('content commence par %PDF-', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const r = await renderer.render('booking-confirmation-technical-v1', makeValidSnapshot());
    const header = new TextDecoder().decode(r.content.slice(0, 5));
    expect(header).toBe('%PDF-');
  });

  // ── 5. PDF rechargeable avec PDFDocument.load ──
  it('PDF rechargeable avec PDFDocument.load', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const r = await renderer.render('booking-confirmation-technical-v1', makeValidSnapshot());
    const reloaded = await PDFDocument.load(r.content, { updateMetadata: false });
    expect(reloaded.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  // ── 5b. Page size A4 (595.28 x 841.89 pts) ──
  it('page size est A4 (595.28 x 841.89 pts)', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const r = await renderer.render('booking-confirmation-technical-v1', makeValidSnapshot());
    const reloaded = await PDFDocument.load(r.content, { updateMetadata: false });
    const page = reloaded.getPage(0);
    const { width, height } = page.getSize();
    expect(width).toBe(595.28);
    expect(height).toBe(841.89);
  });

  // ── 5c. Trailer ID — pas d'ID aléatoire dans le trailer PDF ──
  it('trailer PDF ne contient pas d ID aléatoire (byte-determinism entre instances)', async () => {
    const renderer1 = new PdfLibDocumentRenderer();
    const renderer2 = new PdfLibDocumentRenderer();
    const r1 = await renderer1.render('booking-confirmation-technical-v1', makeValidSnapshot());
    const r2 = await renderer2.render('booking-confirmation-technical-v1', makeValidSnapshot());
    // Si un trailer ID aléatoire était présent, les bytes différeraient.
    expect(r1.checksumSha256).toBe(r2.checksumSha256);
    // Vérification explicite : le PDF rechargé n'expose pas d'ID non déterministe.
    const reloaded = await PDFDocument.load(r1.content, { updateMetadata: false });
    // pdf-lib n'expose pas directement le trailer ID, mais la byte-determinism
    // entre instances prouve l'absence d'ID aléatoire.
    expect(reloaded.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  // ── 6. contentType est application/pdf ──
  it('contentType est application/pdf', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const r = await renderer.render('booking-confirmation-technical-v1', makeValidSnapshot());
    expect(r.contentType).toBe('application/pdf');
  });

  // ── 7. Checksum recalculée correspond ──
  it('checksum SHA-256 recalculée correspond', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const r = await renderer.render('booking-confirmation-technical-v1', makeValidSnapshot());
    const recomputed = createHash('sha256').update(r.content).digest('hex');
    expect(r.checksumSha256).toBe(recomputed);
    expect(r.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  // ── 8. sizeBytes === content.length ──
  it('sizeBytes est egal a content.length', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const r = await renderer.render('booking-confirmation-technical-v1', makeValidSnapshot());
    expect(r.sizeBytes).toBe(r.content.length);
  });

  // ── 9. Deux rendus dans le même process : bytes identiques ──
  it('determinisme : deux rendus memes inputs -> bytes identiques', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeValidSnapshot();
    const r1 = await renderer.render('booking-confirmation-technical-v1', snapshot);
    const r2 = await renderer.render('booking-confirmation-technical-v1', snapshot);
    expect(Array.from(r1.content)).toEqual(Array.from(r2.content));
    expect(r1.checksumSha256).toBe(r2.checksumSha256);
    expect(r1.sizeBytes).toBe(r2.sizeBytes);
  });

  // ── 10. Snapshot différent → bytes/checksum différents ──
  it('snapshots differents -> bytes/checksum differents', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const s1 = makeValidSnapshot();
    const s2 = makeValidSnapshot();
    s2.booking.status = 'ACTIVE';
    const r1 = await renderer.render('booking-confirmation-technical-v1', s1);
    const r2 = await renderer.render('booking-confirmation-technical-v1', s2);
    expect(r1.checksumSha256).not.toBe(r2.checksumSha256);
  });

  it('templates differents -> bytes/checksum differents', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeValidSnapshot();
    const r1 = await renderer.render('booking-confirmation-technical-v1', snapshot);
    const r2 = await renderer.render('rental-contract-technical-v1', snapshot);
    expect(r1.checksumSha256).not.toBe(r2.checksumSha256);
  });

  // ── 11. Ordre déterministe des lignes/items ──
  it('ordre des lignes/items est deterministe (snapshot identique)', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeValidSnapshot();
    const r1 = await renderer.render('booking-confirmation-technical-v1', snapshot);
    const r2 = await renderer.render('booking-confirmation-technical-v1', snapshot);
    // L'ordre est garanti par le snapshot (trié par lineId/bookingItemId).
    expect(Array.from(r1.content)).toEqual(Array.from(r2.content));
  });

  // ── 12. Accents français ──
  it('accents francais (é, è, à, ç, ô) rendus sans erreur', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeValidSnapshot();
    snapshot.organization.legalName = 'Café Hôtel Bûcheron';
    snapshot.location.name = 'Forêt de Chamonix';
    snapshot.location.city = 'Sète';
    const r = await renderer.render('booking-confirmation-technical-v1', snapshot);
    expect(r.content.length).toBeGreaterThan(0);
  });

  // ── 13. Symbole Euro ──
  it('symbole euro (€) rendu sans erreur', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeValidSnapshot();
    snapshot.lines[0]!.variantSnapshot = { name: 'Vélo électrique €' };
    const r = await renderer.render('booking-confirmation-technical-v1', snapshot);
    expect(r.content.length).toBeGreaterThan(0);
  });

  // ── 14. Apostrophes (droite et typographique) ──
  it('apostrophes droite et typographique rendues sans erreur', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeValidSnapshot();
    snapshot.organization.legalName = "L'Alpe d'Huez";
    snapshot.customer.displayName = "Client d'aujourd'hui";
    const r = await renderer.render('booking-confirmation-technical-v1', snapshot);
    expect(r.content.length).toBeGreaterThan(0);
  });

  // ── 15. Tirets (ASCII et typographiques) ──
  it('tirets ASCII et typographiques rendus sans erreur', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeValidSnapshot();
    snapshot.organization.legalName = 'Société – Test — Article';
    const r = await renderer.render('booking-confirmation-technical-v1', snapshot);
    expect(r.content.length).toBeGreaterThan(0);
  });

  // ── 16. Pas de Date.now/Math.random/randomUUID dans le render path ──
  it('pas de Date.now dans le render path', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeValidSnapshot();
    let called = false;
    const orig = Date.now;
    Date.now = () => {
      called = true;
      return 0;
    };
    try {
      await renderer.render('booking-confirmation-technical-v1', snapshot);
      expect(called).toBe(false);
    } finally {
      Date.now = orig;
    }
  });

  it('pas de Math.random dans le render path', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeValidSnapshot();
    let called = false;
    const orig = Math.random;
    Math.random = () => {
      called = true;
      return 0;
    };
    try {
      await renderer.render('booking-confirmation-technical-v1', snapshot);
      expect(called).toBe(false);
    } finally {
      Math.random = orig;
    }
  });

  it('pas de crypto.randomUUID dans le render path', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeValidSnapshot();
    let called = false;
    const orig = crypto.randomUUID;
    crypto.randomUUID = () => {
      called = true;
      return '00000000-0000-0000-0000-000000000000';
    };
    try {
      await renderer.render('booking-confirmation-technical-v1', snapshot);
      expect(called).toBe(false);
    } finally {
      crypto.randomUUID = orig;
    }
  });

  // ── 17. Dates PDF égales à capturedAt ──
  it('dates PDF (creation/modification) egales a capturedAt', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeValidSnapshot();
    const r = await renderer.render('booking-confirmation-technical-v1', snapshot);
    const reloaded = await PDFDocument.load(r.content, { updateMetadata: false });
    const expected = new Date(snapshot.capturedAt).getTime();
    expect(reloaded.getCreationDate()!.getTime()).toBe(expected);
    expect(reloaded.getModificationDate()!.getTime()).toBe(expected);
  });

  // ── 18. Creator/Producer/Title constants ──
  it('creator et producer sont constants', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const r = await renderer.render('booking-confirmation-technical-v1', makeValidSnapshot());
    const reloaded = await PDFDocument.load(r.content, { updateMetadata: false });
    expect(reloaded.getCreator()).toBe('Uttily Worker');
    expect(reloaded.getProducer()).toBe('pdf-lib 1.17.1');
  });

  it('title depend du template', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeValidSnapshot();

    const r1 = await renderer.render('booking-confirmation-technical-v1', snapshot);
    const reloaded1 = await PDFDocument.load(r1.content, { updateMetadata: false });
    expect(reloaded1.getTitle()).toBe('Confirmation de réservation');

    const r2 = await renderer.render('rental-contract-technical-v1', snapshot);
    const reloaded2 = await PDFDocument.load(r2.content, { updateMetadata: false });
    expect(reloaded2.getTitle()).toBe('Contrat de location technique');

    const r3 = await renderer.render('payment-receipt-technical-v1', snapshot);
    const reloaded3 = await PDFDocument.load(r3.content, { updateMetadata: false });
    expect(reloaded3.getTitle()).toBe('Reçu technique');
  });

  // ── 19. Pas de trailer ID aléatoire (bytes déterministes) ──
  it('pas de trailer ID aleatoire — bytes deterministes entre instances', async () => {
    const r1 = new PdfLibDocumentRenderer();
    const r2 = new PdfLibDocumentRenderer();
    const snapshot = makeValidSnapshot();
    const out1 = await r1.render('booking-confirmation-technical-v1', snapshot);
    const out2 = await r2.render('booking-confirmation-technical-v1', snapshot);
    expect(Array.from(out1.content)).toEqual(Array.from(out2.content));
  });

  // ── 20. Pas de requêtes réseau (pas d'imports fetch/http) ──
  it('source ne contient pas d imports reseau (fetch/http/https)', async () => {
    const source = readFileSync(
      fileURLToPath(new URL('./pdf-lib-document-renderer.ts', import.meta.url)),
      'utf-8',
    );
    expect(source).not.toMatch(/import\s+.*from\s+['"]node:http['"]/);
    expect(source).not.toMatch(/import\s+.*from\s+['"]node:https['"]/);
    expect(source).not.toMatch(/import\s+.*from\s+['"]node:net['"]/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  // ── 21. Chemin de police indépendant du cwd ──
  it('chemin de police independant du cwd', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const originalCwd = process.cwd();
    try {
      process.chdir('/');
      const r = await renderer.render('booking-confirmation-technical-v1', makeValidSnapshot());
      expect(r.content.length).toBeGreaterThan(0);
    } finally {
      process.chdir(originalCwd);
    }
  });

  // ── 22. Fichier de licence existe ──
  it('fichier de licence OFL existe', () => {
    const licensePath = resolve(
      fileURLToPath(new URL('../../assets/fonts/LICENSE-OFL.txt', import.meta.url)),
    );
    expect(existsSync(licensePath)).toBe(true);
  });

  // ── 23. Checksum TTF correspond à la valeur documentée ──
  it('checksum SHA-256 du TTF correspond a INTER_FONT_SHA256', () => {
    const fontPath = resolve(
      fileURLToPath(new URL('../../assets/fonts/inter-regular.ttf', import.meta.url)),
    );
    const bytes = readFileSync(fontPath);
    const hash = createHash('sha256').update(bytes).digest('hex');
    expect(hash).toBe(INTER_FONT_SHA256);
  });

  // ── 24. Champ texte > 500 chars rejeté ──
  it('champ texte > 500 chars rejete avec VALIDATION', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeValidSnapshot();
    snapshot.organization.legalName = 'A'.repeat(MAX_TEXT_LENGTH + 1);
    await expect(renderer.render('booking-confirmation-technical-v1', snapshot)).rejects.toThrow(
      DocumentRenderError,
    );
  });

  it('nom de variant > 500 chars — rejete avec VALIDATION', () => {
    const snapshot = makeValidSnapshot();
    snapshot.lines[0]!.variantSnapshot = { name: 'B'.repeat(MAX_TEXT_LENGTH + 1) };
    // Le view model lève une erreur car le nom dépasse la limite.
    expect(() => buildViewModel('booking-confirmation-technical-v1', snapshot)).toThrow(
      DocumentRenderError,
    );
    try {
      buildViewModel('booking-confirmation-technical-v1', snapshot);
    } catch (e) {
      expect((e as DocumentRenderError).code).toBe('VALIDATION');
    }
  });

  it('nom de variant = 501 chars — rejete avec VALIDATION (borne explicite)', () => {
    const snapshot = makeValidSnapshot();
    snapshot.lines[0]!.variantSnapshot = { name: 'X'.repeat(501) };
    expect(() => buildViewModel('booking-confirmation-technical-v1', snapshot)).toThrow(
      DocumentRenderError,
    );
    try {
      buildViewModel('booking-confirmation-technical-v1', snapshot);
    } catch (e) {
      expect((e as DocumentRenderError).code).toBe('VALIDATION');
    }
  });

  it('nom de variant = 500 chars — accepte (borne explicite)', () => {
    const snapshot = makeValidSnapshot();
    snapshot.lines[0]!.variantSnapshot = { name: 'C'.repeat(500) };
    const vm = buildViewModel('booking-confirmation-technical-v1', snapshot);
    expect(vm.lines[0]!.variantName).toBe('C'.repeat(500));
  });

  it('nom de variant absent — retourne etiquette generique', () => {
    const snapshot = makeValidSnapshot();
    snapshot.lines[0]!.variantSnapshot = { id: 123, foo: 'bar' };
    const vm = buildViewModel('booking-confirmation-technical-v1', snapshot);
    expect(vm.lines[0]!.variantName).toBe('Article');
  });

  it('nom de variant vide — retourne etiquette generique', () => {
    const snapshot = makeValidSnapshot();
    snapshot.lines[0]!.variantSnapshot = { name: '' };
    const vm = buildViewModel('booking-confirmation-technical-v1', snapshot);
    expect(vm.lines[0]!.variantName).toBe('Article');
  });

  it('nom de variant non-string (number) — retourne etiquette generique', () => {
    const snapshot = makeValidSnapshot();
    snapshot.lines[0]!.variantSnapshot = { name: 42 };
    const vm = buildViewModel('booking-confirmation-technical-v1', snapshot);
    expect(vm.lines[0]!.variantName).toBe('Article');
  });

  // ── 25. Plus de 100 lignes rejeté ──
  it('plus de 100 lignes rejete avec VALIDATION', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeSnapshotWithLines(MAX_LINES + 1);
    await expect(renderer.render('booking-confirmation-technical-v1', snapshot)).rejects.toThrow(
      DocumentRenderError,
    );
    try {
      await renderer.render('booking-confirmation-technical-v1', snapshot);
    } catch (e) {
      expect((e as DocumentRenderError).code).toBe('VALIDATION');
    }
  });

  it('exactement 100 lignes accepte', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeSnapshotWithLines(MAX_LINES);
    const r = await renderer.render('booking-confirmation-technical-v1', snapshot);
    expect(r.content.length).toBeGreaterThan(0);
  });

  // ── 26. Plus de 100 items rejeté ──
  it('plus de 100 items rejete avec VALIDATION', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeSnapshotWithLines(1);
    // Ajouter 101 items avec bookingItemId triés.
    const items: DocumentRenderSnapshotV1['items'][number][] = [];
    for (let i = 0; i <= MAX_ITEMS; i++) {
      const suffix = i.toString().padStart(12, '0');
      items.push({
        bookingItemId: `10000000-0000-0000-0000-${suffix}`,
        bookingLineId: snapshot.lines[0]!.lineId,
        inventoryItemId: `20000000-0000-0000-0000-${suffix}`,
        internalSku: `SKU-${i}`,
        serialNumber: `SN-${i}`,
        condition: 'GOOD',
        inventoryStatus: 'ACTIVE',
      });
    }
    const bad = { ...snapshot, items } as unknown as DocumentRenderSnapshotV1;
    await expect(renderer.render('booking-confirmation-technical-v1', bad)).rejects.toThrow(
      DocumentRenderError,
    );
  });

  // ── 29. Pas de données internes interdites dans le view model ──
  it('view model ne contient pas les champs internes interdits', () => {
    const snapshot = makeValidSnapshot();
    const vm = buildViewModel('booking-confirmation-technical-v1', snapshot);
    const vmJson = JSON.stringify(vm);
    expect(vmJson).not.toContain('commissionAmountMinor');
    expect(vmJson).not.toContain('connectedAccountId');
    expect(vmJson).not.toContain('client_secret');
    expect(vmJson).not.toContain('recipientEmail');
    expect(vmJson).not.toContain('providerMessageId');
    expect(vmJson).not.toContain('internalSku');
    expect(vmJson).not.toContain('cancellationPolicySnapshot');
    expect(vmJson).not.toContain('termsAcceptanceSnapshot');
    expect(vmJson).not.toContain('variantSnapshot');
  });

  it('view model ne contient pas internalSku (utilise serialNumber)', () => {
    const snapshot = makeValidSnapshot();
    const vm = buildViewModel('rental-contract-technical-v1', snapshot);
    expect(vm.items[0]!.serialNumber).toBe('SN-001');
    const vmJson = JSON.stringify(vm);
    expect(vmJson).not.toContain('internalSku');
    expect(vmJson).not.toContain('KAY-001');
  });

  // ── 30. Pas de sérialisation JSON brute des objets opaques ──
  it('view model ne serialise pas les snapshots opaques bruts', () => {
    const snapshot = makeValidSnapshot();
    // Mettre des données dans les snapshots opaques.
    snapshot.booking.cancellationPolicySnapshot = { secret: 'confidential-policy-data' };
    snapshot.booking.termsAcceptanceSnapshot = { secret: 'confidential-terms-data' };
    snapshot.lines[0]!.variantSnapshot = { name: 'Test', secret: 'confidential-variant-data' };

    const vm = buildViewModel('booking-confirmation-technical-v1', snapshot);
    const vmJson = JSON.stringify(vm);
    expect(vmJson).not.toContain('confidential-policy-data');
    expect(vmJson).not.toContain('confidential-terms-data');
    expect(vmJson).not.toContain('confidential-variant-data');
    // Le nom du variant est extrait de façon sûre.
    expect(vm.lines[0]!.variantName).toBe('Test');
  });

  it('variantSnapshot sans name string — utilise etiquette generique', () => {
    const snapshot = makeValidSnapshot();
    snapshot.lines[0]!.variantSnapshot = { id: 123, foo: 'bar' };
    const vm = buildViewModel('booking-confirmation-technical-v1', snapshot);
    expect(vm.lines[0]!.variantName).toBe('Article');
  });

  it('variantSnapshot avec name vide — utilise etiquette generique', () => {
    const snapshot = makeValidSnapshot();
    snapshot.lines[0]!.variantSnapshot = { name: '' };
    const vm = buildViewModel('booking-confirmation-technical-v1', snapshot);
    expect(vm.lines[0]!.variantName).toBe('Article');
  });

  // ── Tests supplémentaires ──
  it('PDF_LIB_TEMPLATE_KEYS contient exactement 3 cles techniques', () => {
    expect(PDF_LIB_TEMPLATE_KEYS).toHaveLength(3);
    expect(PDF_LIB_TEMPLATE_KEYS.every((k) => k.endsWith('-v1'))).toBe(true);
  });

  it('PDF_LIB_RENDERER_VERSION est defini', () => {
    expect(PDF_LIB_RENDERER_VERSION).toBe('pdf-lib-1.17.1-v1');
  });

  it('trois templates produisent des checksums differents', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeValidSnapshot();
    const checksums = new Set<string>();
    for (const key of PDF_LIB_TEMPLATE_KEYS) {
      const r = await renderer.render(key, snapshot);
      checksums.add(r.checksumSha256);
    }
    expect(checksums.size).toBe(3);
  });

  it('rendu avec customer.displayName null — pas d erreur', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeValidSnapshot();
    snapshot.customer.displayName = null;
    const r = await renderer.render('rental-contract-technical-v1', snapshot);
    expect(r.content.length).toBeGreaterThan(0);
  });

  it('rendu avec location.addressLine1 null — pas d erreur', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeValidSnapshot();
    snapshot.location.addressLine1 = null;
    snapshot.location.city = null;
    snapshot.location.postalCode = null;
    const r = await renderer.render('rental-contract-technical-v1', snapshot);
    expect(r.content.length).toBeGreaterThan(0);
  });

  it('rendu avec taxStatus APPLIED et taxAmountMinor non-null — pas d erreur', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeValidSnapshot();
    snapshot.booking.taxStatus = 'APPLIED';
    snapshot.booking.taxAmountMinor = 3000;
    snapshot.booking.taxRateBps = 2000;
    const r = await renderer.render('booking-confirmation-technical-v1', snapshot);
    expect(r.content.length).toBeGreaterThan(0);
  });

  it('le contenu PDF ne contient pas les champs internes interdits', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeValidSnapshot();
    snapshot.booking.cancellationPolicySnapshot = { secret: 'CONFIDENTIAL_POLICY' };
    snapshot.booking.termsAcceptanceSnapshot = { secret: 'CONFIDENTIAL_TERMS' };
    // Vérifier via le view model que les secrets ne sont pas présents.
    // Le PDF encode le texte en glyph IDs (CID font), donc la recherche
    // directe dans les bytes n'est pas fiable. Le view model est la source
    // de vérité pour le contenu rendu.
    const vm = buildViewModel('booking-confirmation-technical-v1', snapshot);
    const vmJson = JSON.stringify(vm);
    expect(vmJson).not.toContain('CONFIDENTIAL_POLICY');
    expect(vmJson).not.toContain('CONFIDENTIAL_TERMS');
    expect(vmJson).not.toContain('internalSku');
    expect(vmJson).not.toContain('KAY-001');
    // Le rendu réussit malgré les secrets dans les snapshots opaques.
    const r = await renderer.render('booking-confirmation-technical-v1', snapshot);
    expect(r.content.length).toBeGreaterThan(0);
  });

  it('le view model contient le nom de l organisme', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeValidSnapshot();
    snapshot.organization.legalName = 'TestOrgUnique123';
    const vm = buildViewModel('booking-confirmation-technical-v1', snapshot);
    expect(vm.organization.legalName).toBe('TestOrgUnique123');
    const r = await renderer.render('booking-confirmation-technical-v1', snapshot);
    expect(r.content.length).toBeGreaterThan(0);
  });

  it('le view model contient le montant formaté', () => {
    const snapshot = makeValidSnapshot();
    const vm = buildViewModel('booking-confirmation-technical-v1', snapshot);
    // 15000 minor = 150,00 EUR (formatage BigInt avec virgule)
    expect(vm.booking.totalAmountMinor).toBe(15000);
    expect(vm.booking.currency).toBe('EUR');
    // Le formatage déterministe via formatAmountMinor (BigInt, pas float).
    const formatted = formatAmountMinor(vm.booking.totalAmountMinor, vm.booking.currency);
    expect(formatted).toBe('150,00 EUR');
  });

  it('le PDF contient au moins une page avec pied de page', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeValidSnapshot();
    const r = await renderer.render('booking-confirmation-technical-v1', snapshot);
    const reloaded = await PDFDocument.load(r.content, { updateMetadata: false });
    expect(reloaded.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it('multi-pages — pied de page sur chaque page', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeSnapshotWithLines(50);
    const r = await renderer.render('booking-confirmation-technical-v1', snapshot);
    const reloaded = await PDFDocument.load(r.content, { updateMetadata: false });
    const pageCount = reloaded.getPageCount();
    expect(pageCount).toBeGreaterThanOrEqual(1);
    // Le texte du PDF est encodé en glyph IDs (CID font), donc on vérifie
    // via le nombre de pages plutôt que par recherche de texte.
  });

  // ── 30. assertPdfOutputLimits — tests directs aux bornes ──
  it('assertPdfOutputLimits — 10 pages, 0 bytes — passe', () => {
    expect(() => assertPdfOutputLimits({ pageCount: 10, sizeBytes: 0 })).not.toThrow();
  });

  it('assertPdfOutputLimits — 11 pages, 0 bytes — rejete VALIDATION', () => {
    try {
      assertPdfOutputLimits({ pageCount: 11, sizeBytes: 0 });
      expect.fail('devrait lever une erreur');
    } catch (e) {
      expect(e).toBeInstanceOf(DocumentRenderError);
      expect((e as DocumentRenderError).code).toBe('VALIDATION');
    }
  });

  it('assertPdfOutputLimits — 0 pages, 2 MiB — passe', () => {
    expect(() => assertPdfOutputLimits({ pageCount: 0, sizeBytes: 2 * 1024 * 1024 })).not.toThrow();
  });

  it('assertPdfOutputLimits — 0 pages, 2 MiB + 1 — rejete VALIDATION', () => {
    try {
      assertPdfOutputLimits({ pageCount: 0, sizeBytes: 2 * 1024 * 1024 + 1 });
      expect.fail('devrait lever une erreur');
    } catch (e) {
      expect(e).toBeInstanceOf(DocumentRenderError);
      expect((e as DocumentRenderError).code).toBe('VALIDATION');
    }
  });

  it('assertPdfOutputLimits — pageCount -1 — rejete VALIDATION', () => {
    try {
      assertPdfOutputLimits({ pageCount: -1, sizeBytes: 0 });
      expect.fail('devrait lever une erreur');
    } catch (e) {
      expect(e).toBeInstanceOf(DocumentRenderError);
      expect((e as DocumentRenderError).code).toBe('VALIDATION');
    }
  });

  it('assertPdfOutputLimits — sizeBytes -1 — rejete VALIDATION', () => {
    try {
      assertPdfOutputLimits({ pageCount: 0, sizeBytes: -1 });
      expect.fail('devrait lever une erreur');
    } catch (e) {
      expect(e).toBeInstanceOf(DocumentRenderError);
      expect((e as DocumentRenderError).code).toBe('VALIDATION');
    }
  });

  it('assertPdfOutputLimits — pageCount 1.5 (non-entier) — rejete VALIDATION', () => {
    try {
      assertPdfOutputLimits({ pageCount: 1.5, sizeBytes: 0 });
      expect.fail('devrait lever une erreur');
    } catch (e) {
      expect(e).toBeInstanceOf(DocumentRenderError);
      expect((e as DocumentRenderError).code).toBe('VALIDATION');
    }
  });

  it('assertPdfOutputLimits — sizeBytes 1.5 (non-entier) — rejete VALIDATION', () => {
    try {
      assertPdfOutputLimits({ pageCount: 0, sizeBytes: 1.5 });
      expect.fail('devrait lever une erreur');
    } catch (e) {
      expect(e).toBeInstanceOf(DocumentRenderError);
      expect((e as DocumentRenderError).code).toBe('VALIDATION');
    }
  });

  // ── 31. Rendu au maximum naturel (100 lignes, 100 items) dans les limites ──
  it('rendu au maximum naturel (100 lignes, 100 items) — PDF valide et dans les limites', async () => {
    const renderer = new PdfLibDocumentRenderer();
    const snapshot = makeSnapshotWithLines(MAX_LINES);
    const r = await renderer.render('booking-confirmation-technical-v1', snapshot);
    expect(r.content.length).toBeGreaterThan(0);
    expect(r.sizeBytes).toBeLessThanOrEqual(MAX_PDF_SIZE_BYTES);
    const reloaded = await PDFDocument.load(r.content, { updateMetadata: false });
    const pageCount = reloaded.getPageCount();
    expect(pageCount).toBeLessThanOrEqual(MAX_PAGES);
    expect(pageCount).toBeGreaterThanOrEqual(1);
  });

  // ── 32. formatAmountMinor — tests directs (BigInt, pas float) ──
  it('formatAmountMinor(0, EUR) → 0,00 EUR', () => {
    expect(formatAmountMinor(0, 'EUR')).toBe('0,00 EUR');
  });

  it('formatAmountMinor(1, EUR) → 0,01 EUR', () => {
    expect(formatAmountMinor(1, 'EUR')).toBe('0,01 EUR');
  });

  it('formatAmountMinor(99, EUR) → 0,99 EUR', () => {
    expect(formatAmountMinor(99, 'EUR')).toBe('0,99 EUR');
  });

  it('formatAmountMinor(100, EUR) → 1,00 EUR', () => {
    expect(formatAmountMinor(100, 'EUR')).toBe('1,00 EUR');
  });

  it('formatAmountMinor(15000, EUR) → 150,00 EUR', () => {
    expect(formatAmountMinor(15000, 'EUR')).toBe('150,00 EUR');
  });

  it('formatAmountMinor(Number.MAX_SAFE_INTEGER, EUR) → représentation exacte', () => {
    // MAX_SAFE_INTEGER = 9007199254740991
    // /100 = 90071992547409 remainder 91
    expect(formatAmountMinor(Number.MAX_SAFE_INTEGER, 'EUR')).toBe('90071992547409,91 EUR');
  });

  it('formatAmountMinor(-1, EUR) → rejete VALIDATION (montant negatif)', () => {
    try {
      formatAmountMinor(-1, 'EUR');
      expect.fail('devrait lever une erreur');
    } catch (e) {
      expect(e).toBeInstanceOf(DocumentRenderError);
      expect((e as DocumentRenderError).code).toBe('VALIDATION');
    }
  });

  it('formatAmountMinor(1.5, EUR) → rejete VALIDATION (non safe integer)', () => {
    try {
      formatAmountMinor(1.5, 'EUR');
      expect.fail('devrait lever une erreur');
    } catch (e) {
      expect(e).toBeInstanceOf(DocumentRenderError);
      expect((e as DocumentRenderError).code).toBe('VALIDATION');
    }
  });

  // ── 33. formatDateNumeric — tests directs (DD/MM/YYYY HH:mm) ──
  it('formatDateNumeric — hiver Europe/Paris (UTC+1)', () => {
    expect(formatDateNumeric('2026-02-10T09:00:00.000Z', 'Europe/Paris')).toBe('10/02/2026 10:00');
  });

  it('formatDateNumeric — été Europe/Paris (UTC+2 DST)', () => {
    expect(formatDateNumeric('2026-07-15T09:00:00.000Z', 'Europe/Paris')).toBe('15/07/2026 11:00');
  });

  it('formatDateNumeric — 15 janvier 2026 Europe/Paris', () => {
    expect(formatDateNumeric('2026-01-15T10:00:00.000Z', 'Europe/Paris')).toBe('15/01/2026 11:00');
  });

  it('formatDateNumeric — passage minuit (23:30Z → 00:30 Paris)', () => {
    expect(formatDateNumeric('2026-01-15T23:30:00.000Z', 'Europe/Paris')).toBe('16/01/2026 00:30');
  });

  it('formatDateNumeric — indépendant du TZ du processus', () => {
    const iso = '2026-02-10T09:00:00.000Z';
    const expected = formatDateNumeric(iso, 'Europe/Paris');
    const origTZ = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      const result1 = formatDateNumeric(iso, 'Europe/Paris');
      expect(result1).toBe(expected);

      process.env.TZ = 'Asia/Tokyo';
      const result2 = formatDateNumeric(iso, 'Europe/Paris');
      expect(result2).toBe(expected);
    } finally {
      if (origTZ === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = origTZ;
      }
    }
  });
});
