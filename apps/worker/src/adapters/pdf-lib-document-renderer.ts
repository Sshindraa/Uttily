/**
 * @uttily/worker — Renderer PDF déterministe via pdf-lib (G5H-C2C-B2, ADR-013).
 *
 * Implémente DocumentRenderer avec pdf-lib + @pdf-lib/fontkit. Trois templates
 * techniques : confirmation de réservation, contrat de location technique,
 * reçu technique.
 *
 * Déterminisme : mêmes inputs -> mêmes bytes/checksum/taille.
 * - PDFDocument.create({ updateMetadata: false }) : pas de metadata auto.
 * - Dates PDF fixées depuis snapshot.capturedAt (pas de Date.now()).
 * - RNG interne pdf-lib seedé (SimpleRNG.withSeed(1)) : pas d'aléa.
 * - Pas de trailer ID aléatoire (trailerInfo.ID jamais assigné).
 * - Aucun réseau, aucune horloge interne, aucun UUID généré.
 *
 * Sécurité :
 * - Aucune donnée hostile interpolée dans les messages d'erreur.
 * - View model fermé : exclut les champs internes (commissionAmountMinor,
 *   connectedAccountId, client_secret, recipientEmail, providerMessageId,
 *   internalSku, snapshots opaques bruts).
 * - Limites strictes : texte <= 500 chars, lignes <= 100, items <= 100,
 *   pages <= 10, taille <= 2 MiB.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

import { DocumentRenderError } from '@uttily/core';
import type { DocumentRenderer, DocumentRenderSnapshotV1, RenderedDocument } from '@uttily/core';
import { parseDocumentRenderSnapshotV1 } from '@uttily/core';

// ─────────────────────────────────────────────────────────────────────────────
// Constantes publiques
// ─────────────────────────────────────────────────────────────────────────────

export const PDF_LIB_RENDERER_VERSION = 'pdf-lib-1.17.1-v1';
export const PDF_CONTENT_TYPE = 'application/pdf';

export const PDF_LIB_TEMPLATE_KEYS = [
  'booking-confirmation-technical-v1',
  'rental-contract-technical-v1',
  'payment-receipt-technical-v1',
] as const;
export type PdfLibTemplateKey = (typeof PDF_LIB_TEMPLATE_KEYS)[number];

export const INTER_FONT_SHA256 = '40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82';

// ─────────────────────────────────────────────────────────────────────────────
// Limites
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_TEXT_LENGTH = 500;
export const MAX_LINES = 100;
export const MAX_ITEMS = 100;
export const MAX_PAGES = 10;
export const MAX_PDF_SIZE_BYTES = 2 * 1024 * 1024; // 2 MiB

// ─────────────────────────────────────────────────────────────────────────────
// Validation des limites de sortie
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Valide les limites de sortie du PDF (pages et taille).
 * Pure, fermé, sans dépendance externe.
 * Lève DocumentRenderError('VALIDATION') avec message générique.
 * N'inclut jamais les valeurs reçues dans le message.
 */
export function assertPdfOutputLimits(input: {
  readonly pageCount: number;
  readonly sizeBytes: number;
}): void {
  // pageCount
  if (!Number.isInteger(input.pageCount) || input.pageCount < 0) {
    throw new DocumentRenderError('VALIDATION', 'nombre de pages invalide');
  }
  if (input.pageCount > MAX_PAGES) {
    throw new DocumentRenderError('VALIDATION', 'trop de pages');
  }
  // sizeBytes
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 0) {
    throw new DocumentRenderError('VALIDATION', 'taille pdf invalide');
  }
  if (input.sizeBytes > MAX_PDF_SIZE_BYTES) {
    throw new DocumentRenderError('VALIDATION', 'pdf trop volumineux');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Constantes PDF internes
// ─────────────────────────────────────────────────────────────────────────────

const PDF_CREATOR = 'Uttily Worker';
const PDF_PRODUCER = 'pdf-lib 1.17.1';

// A4 en points (1 pt = 1/72 inch). Valeurs fixes (PageSizes.A4 = [595.28, 841.89]).
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 50;
const FOOTER_HEIGHT = 30;
const FONT_SIZE_BODY = 10;
const FONT_SIZE_HEADING = 16;
const FONT_SIZE_SUBHEADING = 12;
const LINE_HEIGHT = 14;
const LINE_HEIGHT_HEADING = 22;
const LINE_HEIGHT_SUBHEADING = 18;

// Couleurs déterministes (RGB normalisé 0-1).
const COLOR_BLACK = rgb(0, 0, 0);
const COLOR_DARK_GRAY = rgb(0.2, 0.2, 0.2);
const COLOR_MEDIUM_GRAY = rgb(0.45, 0.45, 0.45);
const COLOR_LIGHT_GRAY = rgb(0.85, 0.85, 0.85);
const COLOR_ACCENT = rgb(0.1, 0.3, 0.6);
const COLOR_RULE = rgb(0.7, 0.7, 0.7);

// ─────────────────────────────────────────────────────────────────────────────
// Chargement de la police (cache module-level)
// ─────────────────────────────────────────────────────────────────────────────

let cachedFontBytes: Uint8Array | null = null;

/**
 * Résout le chemin de la police TTF depuis import.meta.url.
 *
 * Depuis src/adapters/ (tsx/vitest) : ../../assets/fonts/inter-regular.ttf
 * Depuis dist/ (build esbuild)       : ../assets/fonts/inter-regular.ttf
 *
 * Les deux chemins sont essayés. Le SHA-256 du fichier lu est vérifié contre
 * INTER_FONT_SHA256. Le résultat est mis en cache au niveau module.
 */
function loadInterFontBytes(): Uint8Array {
  if (cachedFontBytes !== null) {
    return cachedFontBytes;
  }

  const currentFile = (() => {
    try {
      return fileURLToPath(import.meta.url);
    } catch {
      throw new DocumentRenderError('VALIDATION', 'resolution chemin police impossible');
    }
  })();

  const baseDir = dirname(currentFile);
  const candidatePaths = [
    resolve(baseDir, '../../assets/fonts/inter-regular.ttf'),
    resolve(baseDir, '../assets/fonts/inter-regular.ttf'),
  ];

  let fontFound = false;
  for (const candidate of candidatePaths) {
    let raw: Buffer;
    try {
      raw = readFileSync(candidate);
    } catch {
      continue;
    }

    const hash = createHash('sha256').update(raw).digest('hex');
    if (hash !== INTER_FONT_SHA256) {
      continue;
    }

    // Convertir Buffer en Uint8Array (copie pour détacher le ArrayBuffer du pool Node).
    const bytes = new Uint8Array(raw.length);
    bytes.set(raw);
    cachedFontBytes = bytes;
    fontFound = true;
    break;
  }

  if (!fontFound) {
    throw new DocumentRenderError('VALIDATION', 'police Inter introuvable ou checksum invalide');
  }

  return cachedFontBytes!;
}

// ─────────────────────────────────────────────────────────────────────────────
// View model — type fermé excluant les champs internes
// ─────────────────────────────────────────────────────────────────────────────

export interface RendererViewModelLine {
  readonly lineId: string;
  readonly variantName: string;
  readonly quantity: number;
  readonly unitPriceAmountMinor: number;
  readonly lineTotalAmountMinor: number;
  readonly currency: string;
}

export interface RendererViewModelItem {
  readonly bookingItemId: string;
  readonly bookingLineId: string;
  readonly serialNumber: string | null;
  readonly condition: string;
  readonly inventoryStatus: string;
}

export interface RendererViewModel {
  readonly templateKey: PdfLibTemplateKey;
  readonly capturedAt: string;
  readonly references: {
    readonly sourceOutboxEventId: string;
    readonly organizationId: string;
    readonly bookingId: string;
    readonly paymentId: string;
    readonly draftId: string;
  };
  readonly organization: { readonly legalName: string };
  readonly location: {
    readonly name: string;
    readonly addressLine1: string | null;
    readonly addressLine2: string | null;
    readonly city: string | null;
    readonly postalCode: string | null;
    readonly countryCode: string | null;
    readonly timeZone: string;
  };
  readonly customer: { readonly displayName: string | null };
  readonly booking: {
    readonly id: string;
    readonly status: string;
    readonly customerStartAt: string;
    readonly customerEndAt: string;
    readonly confirmedAt: string;
    readonly prepBufferMinutes: number;
    readonly cleanupBufferMinutes: number;
    readonly currency: string;
    readonly subtotalAmountMinor: number;
    readonly mandatoryFeesAmountMinor: number;
    readonly totalAmountMinor: number;
    readonly taxStatus: string;
    readonly taxAmountMinor: number | null;
    readonly taxRateBps: number | null;
  };
  readonly payment: {
    readonly id: string;
    readonly succeededAt: string;
    readonly amountMinor: number;
    readonly currency: string;
    readonly financialTermsVersion: string;
    readonly legalTermsVersion: string;
  };
  readonly lines: readonly RendererViewModelLine[];
  readonly items: readonly RendererViewModelItem[];
}

/**
 * Étiquette générique pour un variant dont le nom est absent ou invalide.
 */
const GENERIC_VARIANT_LABEL = 'Article';

/**
 * Extrait le nom du variant depuis variantSnapshot de façon sûre.
 * - name absent, non string, ou string vide → étiquette générique.
 * - name string de 1 à 500 chars → retourne name.
 * - name string > 500 chars → lève DocumentRenderError('VALIDATION').
 * N'expose jamais le snapshot brut.
 */
function extractVariantName(variantSnapshot: Readonly<Record<string, unknown>>): string {
  const name = variantSnapshot['name'];
  if (typeof name !== 'string' || name.length === 0) {
    return GENERIC_VARIANT_LABEL;
  }
  if (name.length > MAX_TEXT_LENGTH) {
    throw new DocumentRenderError('VALIDATION', 'nom de variant trop long');
  }
  return name;
}

/**
 * Construit le view model fermé depuis le snapshot validé.
 *
 * Exclut explicitement :
 * - commissionAmountMinor, commissionRuleSnapshot, taxRuleSnapshot (non présents
 *   dans le snapshot validé, mais l'exclusion est documentée ici).
 * - connectedAccountId, environment, onBehalfOfAccountId, client_secret.
 * - recipientEmail, providerMessageId.
 * - internalSku (utilise serialNumber à la place).
 * - cancellationPolicySnapshot, termsAcceptanceSnapshot, variantSnapshot (bruts).
 *   Seul variantSnapshot.name est extrait de façon sûre.
 *
 * Exporté pour tests unitaires indépendants.
 */
export function buildViewModel(
  templateKey: PdfLibTemplateKey,
  snapshot: DocumentRenderSnapshotV1,
): RendererViewModel {
  return {
    templateKey,
    capturedAt: snapshot.capturedAt,
    references: {
      sourceOutboxEventId: snapshot.sourceOutboxEventId,
      organizationId: snapshot.organizationId,
      bookingId: snapshot.bookingId,
      paymentId: snapshot.paymentId,
      draftId: snapshot.draftId,
    },
    organization: {
      legalName: snapshot.organization.legalName,
    },
    location: {
      name: snapshot.location.name,
      addressLine1: snapshot.location.addressLine1,
      addressLine2: snapshot.location.addressLine2,
      city: snapshot.location.city,
      postalCode: snapshot.location.postalCode,
      countryCode: snapshot.location.countryCode,
      timeZone: snapshot.location.timeZone,
    },
    customer: {
      displayName: snapshot.customer.displayName,
    },
    booking: {
      id: snapshot.booking.id,
      status: snapshot.booking.status,
      customerStartAt: snapshot.booking.customerStartAt,
      customerEndAt: snapshot.booking.customerEndAt,
      confirmedAt: snapshot.booking.confirmedAt,
      prepBufferMinutes: snapshot.booking.prepBufferMinutes,
      cleanupBufferMinutes: snapshot.booking.cleanupBufferMinutes,
      currency: snapshot.booking.currency,
      subtotalAmountMinor: snapshot.booking.subtotalAmountMinor,
      mandatoryFeesAmountMinor: snapshot.booking.mandatoryFeesAmountMinor,
      totalAmountMinor: snapshot.booking.totalAmountMinor,
      taxStatus: snapshot.booking.taxStatus,
      taxAmountMinor: snapshot.booking.taxAmountMinor,
      taxRateBps: snapshot.booking.taxRateBps,
    },
    payment: {
      id: snapshot.payment.id,
      succeededAt: snapshot.payment.succeededAt,
      amountMinor: snapshot.payment.amountMinor,
      currency: snapshot.payment.currency,
      financialTermsVersion: snapshot.payment.financialTermsVersion,
      legalTermsVersion: snapshot.payment.legalTermsVersion,
    },
    lines: snapshot.lines.map((l) => ({
      lineId: l.lineId,
      variantName: extractVariantName(l.variantSnapshot),
      quantity: l.quantity,
      unitPriceAmountMinor: l.unitPriceAmountMinor,
      lineTotalAmountMinor: l.lineTotalAmountMinor,
      currency: l.currency,
    })),
    items: snapshot.items.map((it) => ({
      bookingItemId: it.bookingItemId,
      bookingLineId: it.bookingLineId,
      serialNumber: it.serialNumber,
      condition: it.condition,
      inventoryStatus: it.inventoryStatus,
    })),
  };
}

/**
 * Valide que tous les champs texte du view model sont <= MAX_TEXT_LENGTH.
 * Lève DocumentRenderError('VALIDATION') sans interpoler la valeur.
 */
function validateViewModelTextLengths(vm: RendererViewModel): void {
  const texts: string[] = [
    vm.organization.legalName,
    vm.location.name,
    vm.location.addressLine1 ?? '',
    vm.location.addressLine2 ?? '',
    vm.location.city ?? '',
    vm.location.postalCode ?? '',
    vm.location.countryCode ?? '',
    vm.location.timeZone,
    vm.customer.displayName ?? '',
    vm.booking.id,
    vm.booking.status,
    vm.booking.currency,
    vm.payment.id,
    vm.payment.currency,
    vm.payment.financialTermsVersion,
    vm.payment.legalTermsVersion,
    vm.references.sourceOutboxEventId,
    vm.references.organizationId,
    vm.references.bookingId,
    vm.references.paymentId,
    vm.references.draftId,
  ];

  for (const line of vm.lines) {
    texts.push(line.lineId, line.variantName, line.currency);
  }
  for (const item of vm.items) {
    texts.push(
      item.bookingItemId,
      item.bookingLineId,
      item.serialNumber ?? '',
      item.condition,
      item.inventoryStatus,
    );
  }

  for (const t of texts) {
    if (t.length > MAX_TEXT_LENGTH) {
      throw new DocumentRenderError('VALIDATION', 'champ texte trop long');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de formatage déterministe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formate un montant en unités mineures vers "XX,XX CUR" (séparateur virgule).
 * Utilise BigInt pour éviter toute perte de précision flottante.
 * Aucune dépendance à Intl. Toujours exactement 2 décimales.
 *
 * Exemples :
 * - 0 → "0,00 EUR"
 * - 1 → "0,01 EUR"
 * - 99 → "0,99 EUR"
 * - 100 → "1,00 EUR"
 * - 15000 → "150,00 EUR"
 * - Number.MAX_SAFE_INTEGER → "90071992547409,91 EUR" (exact, sans arrondi)
 */
export function formatAmountMinor(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor)) {
    throw new DocumentRenderError('VALIDATION', 'montant invalide');
  }
  if (minor < 0) {
    throw new DocumentRenderError('VALIDATION', 'montant negatif non autorise');
  }
  const bigMinor = BigInt(minor);
  const major = bigMinor / 100n;
  const cents = bigMinor % 100n;
  const centsStr = cents.toString().padStart(2, '0');
  return `${major.toString()},${centsStr} ${currency}`;
}

/**
 * Formate une date ISO vers "DD/MM/YYYY HH:mm" en utilisant le fuseau IANA
 * du lieu. Utilise Intl.DateTimeFormat avec composants explicites et
 * formatToParts pour assembler la chaîne dans un ordre fixé par le code.
 * Aucune dépendance à la chaîne localisée complète de format().
 *
 * Déterministe : mêmes inputs -> même output, indépendant du TZ du processus.
 */
export function formatDateNumeric(iso: string, timeZone: string): string {
  const dt = new Intl.DateTimeFormat('fr-FR', {
    timeZone,
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = dt.formatToParts(new Date(iso));
  const map = new Map<string, string>();
  for (const part of parts) {
    if (part.type !== 'literal') {
      map.set(part.type, part.value);
    }
  }
  const day = map.get('day') ?? '00';
  const month = map.get('month') ?? '00';
  const year = map.get('year') ?? '0000';
  const hour = map.get('hour') ?? '00';
  const minute = map.get('minute') ?? '00';
  return `${day}/${month}/${year} ${hour}:${minute}`;
}

/**
 * Retourne le titre PDF pour un template key donné.
 */
function titleForTemplate(templateKey: PdfLibTemplateKey): string {
  switch (templateKey) {
    case 'booking-confirmation-technical-v1':
      return 'Confirmation de réservation';
    case 'rental-contract-technical-v1':
      return 'Contrat de location technique';
    case 'payment-receipt-technical-v1':
      return 'Reçu technique';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout engine — gestion des pages, position Y, wrapping
// ─────────────────────────────────────────────────────────────────────────────

interface LayoutContext {
  readonly pdfDoc: PDFDocument;
  readonly font: PDFFont;
  readonly pages: PDFPage[];
  currentPage: PDFPage;
  y: number;
}

function createLayout(pdfDoc: PDFDocument, font: PDFFont): LayoutContext {
  const firstPage = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  return {
    pdfDoc,
    font,
    pages: [firstPage],
    currentPage: firstPage,
    y: PAGE_HEIGHT - MARGIN,
  };
}

function newPage(ctx: LayoutContext): void {
  const page = ctx.pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  ctx.pages.push(page);
  ctx.currentPage = page;
  ctx.y = PAGE_HEIGHT - MARGIN;
}

function ensureSpace(ctx: LayoutContext, heightNeeded: number): void {
  const bottomLimit = MARGIN + FOOTER_HEIGHT;
  if (ctx.y - heightNeeded < bottomLimit) {
    newPage(ctx);
  }
}

function drawTextLine(
  ctx: LayoutContext,
  text: string,
  options?: { size?: number; color?: ReturnType<typeof rgb>; indent?: number; gapAfter?: number },
): void {
  const size = options?.size ?? FONT_SIZE_BODY;
  const color = options?.color ?? COLOR_BLACK;
  const indent = options?.indent ?? 0;
  const gapAfter = options?.gapAfter ?? 0;
  const lineHeight =
    size <= FONT_SIZE_BODY
      ? LINE_HEIGHT
      : size >= FONT_SIZE_HEADING
        ? LINE_HEIGHT_HEADING
        : LINE_HEIGHT_SUBHEADING;

  ensureSpace(ctx, lineHeight);
  ctx.currentPage.drawText(text, {
    x: MARGIN + indent,
    y: ctx.y - size,
    size,
    font: ctx.font,
    color,
  });
  ctx.y -= lineHeight + gapAfter;
}

/**
 * Word-wrap simple : coupe sur les espaces, mesure avec font.widthOfTextAtSize.
 * Les mots trop longs sont coupés par caractère.
 */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  const paragraphs = text.split('\n');

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      lines.push('');
      continue;
    }

    const words = paragraph.split(' ');
    let currentLine = '';

    for (const word of words) {
      const candidate = currentLine.length === 0 ? word : `${currentLine} ${word}`;
      const width = font.widthOfTextAtSize(candidate, size);

      if (width <= maxWidth) {
        currentLine = candidate;
      } else {
        // Si le mot seul est trop long, on le coupe par caractère.
        if (currentLine.length > 0) {
          lines.push(currentLine);
          currentLine = '';
        }

        if (font.widthOfTextAtSize(word, size) <= maxWidth) {
          currentLine = word;
        } else {
          // Coupe par caractère.
          let chunk = '';
          for (const ch of word) {
            const candidateChunk = chunk + ch;
            if (font.widthOfTextAtSize(candidateChunk, size) <= maxWidth) {
              chunk = candidateChunk;
            } else {
              if (chunk.length > 0) {
                lines.push(chunk);
              }
              chunk = ch;
            }
          }
          currentLine = chunk;
        }
      }
    }

    if (currentLine.length > 0) {
      lines.push(currentLine);
    }
  }

  return lines.length === 0 ? [''] : lines;
}

function drawWrappedText(
  ctx: LayoutContext,
  text: string,
  options?: {
    size?: number;
    color?: ReturnType<typeof rgb>;
    indent?: number;
    maxWidth?: number;
    gapAfter?: number;
  },
): void {
  const size = options?.size ?? FONT_SIZE_BODY;
  const color = options?.color ?? COLOR_BLACK;
  const indent = options?.indent ?? 0;
  const maxWidth = options?.maxWidth ?? PAGE_WIDTH - 2 * MARGIN - indent;
  const gapAfter = options?.gapAfter ?? 0;

  const wrappedLines = wrapText(text, ctx.font, size, maxWidth);
  for (const line of wrappedLines) {
    drawTextLine(ctx, line, { size, color, indent, gapAfter: 0 });
  }
  ctx.y -= gapAfter;
}

function drawSpacer(ctx: LayoutContext, height: number): void {
  ensureSpace(ctx, height);
  ctx.y -= height;
}

function drawHorizontalRule(ctx: LayoutContext): void {
  ensureSpace(ctx, 10);
  ctx.currentPage.drawLine({
    start: { x: MARGIN, y: ctx.y },
    end: { x: PAGE_WIDTH - MARGIN, y: ctx.y },
    thickness: 0.5,
    color: COLOR_RULE,
  });
  ctx.y -= 10;
}

function drawHeading(ctx: LayoutContext, text: string): void {
  drawTextLine(ctx, text, { size: FONT_SIZE_HEADING, color: COLOR_ACCENT, gapAfter: 4 });
  drawHorizontalRule(ctx);
}

function drawSubheading(ctx: LayoutContext, text: string): void {
  drawTextLine(ctx, text, { size: FONT_SIZE_SUBHEADING, color: COLOR_DARK_GRAY, gapAfter: 2 });
}

interface LabelValuePair {
  readonly label: string;
  readonly value: string;
}

function drawKeyValueBlock(
  ctx: LayoutContext,
  pairs: readonly LabelValuePair[],
  indent?: number,
): void {
  const ind = indent ?? 0;
  for (const pair of pairs) {
    const text = `${pair.label} : ${pair.value}`;
    drawWrappedText(ctx, text, { indent: ind, gapAfter: 2 });
  }
}

function drawTableHeader(
  ctx: LayoutContext,
  columns: readonly { label: string; width: number }[],
): void {
  ensureSpace(ctx, LINE_HEIGHT + 6);
  let x = MARGIN;
  // Fond léger pour l'en-tête.
  ctx.currentPage.drawRectangle({
    x: MARGIN,
    y: ctx.y - LINE_HEIGHT,
    width: PAGE_WIDTH - 2 * MARGIN,
    height: LINE_HEIGHT,
    color: COLOR_LIGHT_GRAY,
    opacity: 0.5,
  });
  for (const col of columns) {
    ctx.currentPage.drawText(col.label, {
      x,
      y: ctx.y - FONT_SIZE_BODY,
      size: FONT_SIZE_BODY,
      font: ctx.font,
      color: COLOR_DARK_GRAY,
    });
    x += col.width;
  }
  ctx.y -= LINE_HEIGHT + 4;
}

function drawTableRow(
  ctx: LayoutContext,
  columns: readonly { text: string; width: number }[],
): void {
  let x = MARGIN;
  const rowHeight = LINE_HEIGHT;
  ensureSpace(ctx, rowHeight);
  for (const col of columns) {
    const truncated = col.text.length > 60 ? `${col.text.slice(0, 57)}...` : col.text;
    const wrapped = wrapText(truncated, ctx.font, FONT_SIZE_BODY, col.width - 4);
    const firstLine = wrapped[0] ?? '';
    ctx.currentPage.drawText(firstLine, {
      x,
      y: ctx.y - FONT_SIZE_BODY,
      size: FONT_SIZE_BODY,
      font: ctx.font,
      color: COLOR_BLACK,
    });
    x += col.width;
  }
  ctx.y -= rowHeight;
}

function drawFooters(ctx: LayoutContext): void {
  const totalPages = ctx.pages.length;
  for (let i = 0; i < totalPages; i++) {
    const pageNum = i + 1;
    const page = ctx.pages[i]!;
    const footerText = `Document technique généré par Uttily — Page ${pageNum} / ${totalPages}`;
    const textWidth = ctx.font.widthOfTextAtSize(footerText, 8);
    page.drawText(footerText, {
      x: (PAGE_WIDTH - textWidth) / 2,
      y: MARGIN / 2,
      size: 8,
      font: ctx.font,
      color: COLOR_MEDIUM_GRAY,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Layouts par template
// ─────────────────────────────────────────────────────────────────────────────

function renderBookingConfirmation(ctx: LayoutContext, vm: RendererViewModel): void {
  const tz = vm.location.timeZone;

  drawHeading(ctx, 'Confirmation de réservation');

  drawSpacer(ctx, 4);
  drawKeyValueBlock(ctx, [
    { label: 'Référence réservation', value: vm.booking.id },
    { label: 'Organisme', value: vm.organization.legalName },
    { label: 'Lieu', value: vm.location.name },
  ]);

  drawSpacer(ctx, 6);
  drawSubheading(ctx, 'Période');
  drawKeyValueBlock(ctx, [
    { label: 'Début', value: formatDateNumeric(vm.booking.customerStartAt, tz) },
    { label: 'Fin', value: formatDateNumeric(vm.booking.customerEndAt, tz) },
    { label: 'Confirmé le', value: formatDateNumeric(vm.booking.confirmedAt, tz) },
  ]);

  drawSpacer(ctx, 6);
  drawSubheading(ctx, 'Lignes');
  const colWidths: readonly [number, number, number, number] = [220, 60, 100, 115];
  drawTableHeader(ctx, [
    { label: 'Article', width: colWidths[0] },
    { label: 'Quantité', width: colWidths[1] },
    { label: 'Prix unitaire', width: colWidths[2] },
    { label: 'Total ligne', width: colWidths[3] },
  ]);
  for (const line of vm.lines) {
    drawTableRow(ctx, [
      { text: line.variantName, width: colWidths[0] },
      { text: String(line.quantity), width: colWidths[1] },
      { text: formatAmountMinor(line.unitPriceAmountMinor, line.currency), width: colWidths[2] },
      { text: formatAmountMinor(line.lineTotalAmountMinor, line.currency), width: colWidths[3] },
    ]);
  }

  drawSpacer(ctx, 6);
  drawKeyValueBlock(ctx, [
    {
      label: 'Sous-total',
      value: formatAmountMinor(vm.booking.subtotalAmountMinor, vm.booking.currency),
    },
    {
      label: 'Frais obligatoires',
      value: formatAmountMinor(vm.booking.mandatoryFeesAmountMinor, vm.booking.currency),
    },
    { label: 'Total', value: formatAmountMinor(vm.booking.totalAmountMinor, vm.booking.currency) },
  ]);

  if (vm.booking.taxAmountMinor !== null) {
    drawKeyValueBlock(ctx, [
      { label: 'Taxe', value: formatAmountMinor(vm.booking.taxAmountMinor, vm.booking.currency) },
    ]);
  }

  drawSpacer(ctx, 6);
  drawKeyValueBlock(ctx, [{ label: 'Statut réservation', value: vm.booking.status }]);
}

function renderRentalContract(ctx: LayoutContext, vm: RendererViewModel): void {
  const tz = vm.location.timeZone;

  drawHeading(ctx, 'Contrat de location technique');

  drawSpacer(ctx, 4);
  drawSubheading(ctx, 'Parties');
  drawKeyValueBlock(ctx, [
    { label: 'Loueur (organisme)', value: vm.organization.legalName },
    { label: 'Locataire', value: vm.customer.displayName ?? '—' },
  ]);

  drawSpacer(ctx, 6);
  drawSubheading(ctx, 'Références');
  drawKeyValueBlock(ctx, [
    { label: 'Réservation', value: vm.booking.id },
    { label: 'Paiement', value: vm.payment.id },
  ]);

  drawSpacer(ctx, 6);
  drawSubheading(ctx, 'Période et lieu');
  drawKeyValueBlock(ctx, [
    { label: 'Début', value: formatDateNumeric(vm.booking.customerStartAt, tz) },
    { label: 'Fin', value: formatDateNumeric(vm.booking.customerEndAt, tz) },
    { label: 'Lieu', value: vm.location.name },
  ]);

  if (vm.location.addressLine1) {
    drawWrappedText(ctx, vm.location.addressLine1, { indent: 12, gapAfter: 1 });
  }
  if (vm.location.addressLine2) {
    drawWrappedText(ctx, vm.location.addressLine2, { indent: 12, gapAfter: 1 });
  }
  const cityLine = [vm.location.postalCode, vm.location.city].filter((s) => s !== null).join(' ');
  if (cityLine.length > 0) {
    drawWrappedText(ctx, cityLine, { indent: 12, gapAfter: 1 });
  }
  if (vm.location.countryCode) {
    drawWrappedText(ctx, vm.location.countryCode, { indent: 12, gapAfter: 1 });
  }

  drawSpacer(ctx, 6);
  drawSubheading(ctx, 'Équipement');
  const colWidths: readonly [number, number, number] = [240, 130, 125];
  drawTableHeader(ctx, [
    { label: 'Article', width: colWidths[0] },
    { label: 'Numéro de série', width: colWidths[1] },
    { label: 'État', width: colWidths[2] },
  ]);
  for (const item of vm.items) {
    drawTableRow(ctx, [
      { text: lookupVariantNameForItem(vm, item.bookingLineId), width: colWidths[0] },
      { text: item.serialNumber ?? '—', width: colWidths[1] },
      { text: item.condition, width: colWidths[2] },
    ]);
  }

  drawSpacer(ctx, 6);
  drawSubheading(ctx, 'Montant');
  drawKeyValueBlock(ctx, [
    { label: 'Total', value: formatAmountMinor(vm.booking.totalAmountMinor, vm.booking.currency) },
  ]);

  // Pas de clauses légales, pas de signature (document technique uniquement).
  drawSpacer(ctx, 8);
  drawWrappedText(ctx, 'Document technique — sans valeur contractuelle légale.', {
    size: 9,
    color: COLOR_MEDIUM_GRAY,
    gapAfter: 2,
  });
}

/**
 * Retourne le nom du variant pour un item donné via son bookingLineId.
 */
function lookupVariantNameForItem(vm: RendererViewModel, bookingLineId: string): string {
  for (const line of vm.lines) {
    if (line.lineId === bookingLineId) {
      return line.variantName;
    }
  }
  return GENERIC_VARIANT_LABEL;
}

function renderPaymentReceipt(ctx: LayoutContext, vm: RendererViewModel): void {
  const tz = vm.location.timeZone;

  drawHeading(ctx, 'Reçu technique');

  drawSpacer(ctx, 4);
  drawKeyValueBlock(ctx, [
    { label: 'Référence paiement', value: vm.payment.id },
    { label: 'Référence réservation', value: vm.booking.id },
    { label: 'Date de succès', value: formatDateNumeric(vm.payment.succeededAt, tz) },
  ]);

  drawSpacer(ctx, 6);
  drawSubheading(ctx, 'Montant');
  drawKeyValueBlock(ctx, [
    {
      label: 'Montant payé',
      value: formatAmountMinor(vm.payment.amountMinor, vm.payment.currency),
    },
    { label: 'Devise', value: vm.payment.currency },
  ]);

  drawSpacer(ctx, 6);
  drawKeyValueBlock(ctx, [
    { label: 'Organisme', value: vm.organization.legalName },
    { label: 'Lieu', value: vm.location.name },
  ]);

  // Pas une facture fiscale. Pas de TVA inventée.
  drawSpacer(ctx, 8);
  drawWrappedText(ctx, 'Reçu technique — ne constitue pas une facture fiscale.', {
    size: 9,
    color: COLOR_MEDIUM_GRAY,
    gapAfter: 2,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderer
// ─────────────────────────────────────────────────────────────────────────────

export class PdfLibDocumentRenderer implements DocumentRenderer {
  readonly contentType = PDF_CONTENT_TYPE;

  async render(templateKey: string, snapshot: DocumentRenderSnapshotV1): Promise<RenderedDocument> {
    // 1. Valider le template key (sans exposer la valeur recue).
    if (!PDF_LIB_TEMPLATE_KEYS.includes(templateKey as PdfLibTemplateKey)) {
      throw new DocumentRenderError('VALIDATION', 'template key inconnu');
    }
    const typedKey = templateKey as PdfLibTemplateKey;

    // 2. Valider le snapshot via le parser central.
    const validated = parseDocumentRenderSnapshotV1(snapshot);

    // 3. Valider les limites de tableaux.
    if (validated.lines.length > MAX_LINES) {
      throw new DocumentRenderError('VALIDATION', 'trop de lignes');
    }
    if (validated.items.length > MAX_ITEMS) {
      throw new DocumentRenderError('VALIDATION', 'trop d items');
    }

    // 4. Construire et valider le view model.
    const vm = buildViewModel(typedKey, validated);
    validateViewModelTextLengths(vm);

    // 5. Charger la police (cache module-level).
    const fontBytes = loadInterFontBytes();

    // 6. Créer le document PDF déterministe.
    const pdfDoc = await PDFDocument.create({ updateMetadata: false });
    pdfDoc.registerFontkit(fontkit);
    const font = await pdfDoc.embedFont(fontBytes);

    // 7. Métadonnées déterministes depuis le snapshot.
    const capturedDate = new Date(vm.capturedAt);
    pdfDoc.setCreationDate(capturedDate);
    pdfDoc.setModificationDate(capturedDate);
    pdfDoc.setCreator(PDF_CREATOR);
    pdfDoc.setProducer(PDF_PRODUCER);
    pdfDoc.setTitle(titleForTemplate(typedKey));

    // 8. Rendre le layout selon le template.
    const ctx = createLayout(pdfDoc, font);
    switch (typedKey) {
      case 'booking-confirmation-technical-v1':
        renderBookingConfirmation(ctx, vm);
        break;
      case 'rental-contract-technical-v1':
        renderRentalContract(ctx, vm);
        break;
      case 'payment-receipt-technical-v1':
        renderPaymentReceipt(ctx, vm);
        break;
    }

    // 9. Ajouter les pieds de page avec numéros de page.
    drawFooters(ctx);

    // 10. Sérialiser.
    const bytes = await pdfDoc.save();

    // 11. Valider les limites de sortie (pages et taille).
    assertPdfOutputLimits({ pageCount: ctx.pages.length, sizeBytes: bytes.length });

    // 12. Calculer le checksum.
    const checksum = createHash('sha256').update(bytes).digest('hex');

    return {
      content: bytes,
      contentType: PDF_CONTENT_TYPE,
      checksumSha256: checksum,
      sizeBytes: bytes.length,
    };
  }
}
