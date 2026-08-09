import { createHash } from 'node:crypto';
import { IdempotencyError } from './errors';
import type {
  FlexibleIdempotentPayload,
  FlexibleIntentCanonical,
  IdempotentPayload,
  IdempotentPayloadLine,
} from './types';

/**
 * Calcule l'empreinte SHA-256 canonique d'un payload idempotent (ADR-009 section 12).
 *
 * Le JSON canonique est construit avec :
 * - `v: "v1"` (version du schéma d'empreinte)
 * - les champs `organization_id`, `location_id`, `customer_user_id` (strings)
 * - `customer_start_at`, `customer_end_at` en UTC ISO 8601 avec `Z`
 * - `lines` trié par `variant_id` puis par `quantity`, chaque ligne `{ variant_id, quantity }`
 * - ordre des champs trié alphabétiquement (ordre d'insertion préservé par JS)
 * - encodage UTF-8, JSON compact (pas d'espaces, pas de retours)
 *
 * Les champs monétaires (calculés server-side) et non sémantiques (User-Agent, IP,
 * session) sont exclus.
 *
 * @returns empreinte SHA-256 en hexadécimal (64 caractères)
 * @throws IdempotencyError('VALIDATION') si le payload est invalide
 */
export function computeFingerprint(payload: IdempotentPayload): string {
  validatePayload(payload);
  const canonical = buildCanonicalJson(payload);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Construit le JSON canonique versionné (ADR-009 section 12).
 * Les champs sont insérés dans l'ordre alphabétique ; JavaScript préserve l'ordre
 * d'insertion des clés string, donc `JSON.stringify` produit un JSON stable.
 */
function buildCanonicalJson(payload: IdempotentPayload): string {
  const sortedLines = sortLines(payload.lines);
  // Ordre alphabétique : customer_end_at, customer_start_at, customer_user_id,
  // lines, location_id, organization_id, v.
  const canonical = {
    customer_end_at: payload.customerEndAt.toISOString(),
    customer_start_at: payload.customerStartAt.toISOString(),
    customer_user_id: payload.customerUserId,
    lines: sortedLines.map((l) => ({
      variant_id: l.variantId,
      quantity: l.quantity,
    })),
    location_id: payload.locationId,
    organization_id: payload.organizationId,
    v: 'v1',
  };
  return JSON.stringify(canonical);
}

/**
 * Trie les lignes par `variant_id` (clé primaire) puis par `quantity` (clé secondaire)
 * de manière déterministe. La clé secondaire garantit un tri canonique même en
 * présence de doublons de `variant_id` avec des quantités différentes.
 */
function sortLines(lines: IdempotentPayloadLine[]): IdempotentPayloadLine[] {
  return [...lines].sort((a, b) => {
    if (a.variantId !== b.variantId) {
      return a.variantId < b.variantId ? -1 : 1;
    }
    return a.quantity - b.quantity;
  });
}

/**
 * Valide le payload avant le calcul de l'empreinte.
 * @throws IdempotencyError('VALIDATION') si une contrainte n'est pas respectée.
 */
function validatePayload(payload: IdempotentPayload): void {
  if (typeof payload.organizationId !== 'string' || payload.organizationId.length === 0) {
    throw new IdempotencyError('VALIDATION', 'organizationId est requis (string non vide).');
  }
  if (typeof payload.locationId !== 'string' || payload.locationId.length === 0) {
    throw new IdempotencyError('VALIDATION', 'locationId est requis (string non vide).');
  }
  if (typeof payload.customerUserId !== 'string' || payload.customerUserId.length === 0) {
    throw new IdempotencyError('VALIDATION', 'customerUserId est requis (string non vide).');
  }
  if (!isValidDate(payload.customerStartAt)) {
    throw new IdempotencyError('VALIDATION', 'customerStartAt est une date invalide.');
  }
  if (!isValidDate(payload.customerEndAt)) {
    throw new IdempotencyError('VALIDATION', 'customerEndAt est une date invalide.');
  }
  if (!Array.isArray(payload.lines) || payload.lines.length === 0) {
    throw new IdempotencyError('VALIDATION', 'lines doit être un tableau non vide.');
  }
  for (const [i, line] of payload.lines.entries()) {
    if (typeof line.variantId !== 'string' || line.variantId.length === 0) {
      throw new IdempotencyError(
        'VALIDATION',
        `lines[${i}].variantId est requis (string non vide).`,
      );
    }
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new IdempotencyError(
        'VALIDATION',
        `lines[${i}].quantity doit être un entier strictement positif.`,
      );
    }
  }
}

function isValidDate(d: unknown): boolean {
  return d instanceof Date && Number.isFinite(d.getTime());
}

// ─────────────────────────────────────────────────────────────────────────────
// G7P-B2-B — Empreinte flexible (v2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calcule l'empreinte SHA-256 canonique d'un payload idempotent flexible (G7P-B2-B).
 *
 * Le JSON canonique est construit avec :
 * - `v: "v2"` (version du schéma d'empreinte flexible, distinct de v1 legacy)
 * - `pricing_mode: "FLEXIBLE"`
 * - `organization_id`, `location_id`, `customer_user_id` (strings)
 * - `locale` (string)
 * - `intent` : forme canonique (TIME_RANGE → startAt/endAt chaînes locales
 *   ISO 8601 sans offset, DAY_RANGE → startDate/endDateExclusive YYYY-MM-DD)
 * - `lines` trié par `variant_id` puis par `quantity`
 * - ordre des champs trié alphabétiquement
 *
 * @returns empreinte SHA-256 en hexadécimal (64 caractères)
 * @throws IdempotencyError('VALIDATION') si le payload est invalide
 */
export function computeFlexibleFingerprint(payload: FlexibleIdempotentPayload): string {
  validateFlexiblePayload(payload);
  const canonical = buildFlexibleCanonicalJson(payload);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function buildFlexibleCanonicalJson(payload: FlexibleIdempotentPayload): string {
  const sortedLines = sortLines(payload.lines);
  const intent = buildIntentCanonical(payload.intent);
  // G7P-B2-B Round 2 — Defect 1 : canonicaliser la locale (BCP 47) pour un
  // fingerprint déterministe depuis l'entrée seule (pas de dépendance à la
  // locale résolue qui dépend des traductions disponibles).
  const canonicalLocale = canonicalizeLocale(payload.locale);
  // Ordre alphabétique : customer_user_id, intent, lines, locale, location_id,
  // organization_id, pricing_mode, v.
  const canonical = {
    customer_user_id: payload.customerUserId,
    intent,
    lines: sortedLines.map((l) => ({
      variant_id: l.variantId,
      quantity: l.quantity,
    })),
    locale: canonicalLocale,
    location_id: payload.locationId,
    organization_id: payload.organizationId,
    pricing_mode: 'FLEXIBLE',
    v: 'v2',
  };
  return JSON.stringify(canonical);
}

/**
 * Canonicalise une locale BCP 47 de manière déterministe via
 * `Intl.getCanonicalLocales()`. Aucune dépendance à la locale système.
 *
 * @throws IdempotencyError('VALIDATION') si la locale est invalide.
 */
function canonicalizeLocale(locale: string): string {
  const trimmed = locale.trim();
  if (!trimmed) {
    throw new IdempotencyError('VALIDATION', 'locale est requis (string non vide).');
  }
  try {
    const canonical = Intl.getCanonicalLocales(trimmed);
    if (canonical.length === 0) {
      throw new IdempotencyError('VALIDATION', `locale invalide : ${locale}`);
    }
    return canonical[0]!;
  } catch {
    throw new IdempotencyError('VALIDATION', `locale invalide : ${locale}`);
  }
}

function buildIntentCanonical(intent: FlexibleIntentCanonical): Record<string, unknown> {
  if (intent.kind === 'TIME_RANGE') {
    return {
      kind: 'TIME_RANGE',
      startAt: intent.startAt,
      endAt: intent.endAt,
    };
  }
  return {
    kind: 'DAY_RANGE',
    startDate: intent.startDate,
    endDateExclusive: intent.endDateExclusive,
  };
}

function validateFlexiblePayload(payload: FlexibleIdempotentPayload): void {
  if (typeof payload.organizationId !== 'string' || payload.organizationId.length === 0) {
    throw new IdempotencyError('VALIDATION', 'organizationId est requis (string non vide).');
  }
  if (typeof payload.locationId !== 'string' || payload.locationId.length === 0) {
    throw new IdempotencyError('VALIDATION', 'locationId est requis (string non vide).');
  }
  if (typeof payload.customerUserId !== 'string' || payload.customerUserId.length === 0) {
    throw new IdempotencyError('VALIDATION', 'customerUserId est requis (string non vide).');
  }
  if (typeof payload.locale !== 'string' || payload.locale.trim().length === 0) {
    throw new IdempotencyError('VALIDATION', 'locale est requis (string non vide).');
  }
  if (
    !payload.intent ||
    (payload.intent.kind !== 'TIME_RANGE' && payload.intent.kind !== 'DAY_RANGE')
  ) {
    throw new IdempotencyError('VALIDATION', 'intent invalide.');
  }
  if (payload.intent.kind === 'TIME_RANGE') {
    if (typeof payload.intent.startAt !== 'string' || payload.intent.startAt.length === 0) {
      throw new IdempotencyError('VALIDATION', 'intent.startAt est requis (string ISO 8601).');
    }
    if (typeof payload.intent.endAt !== 'string' || payload.intent.endAt.length === 0) {
      throw new IdempotencyError('VALIDATION', 'intent.endAt est requis (string ISO 8601).');
    }
  } else {
    if (typeof payload.intent.startDate !== 'string' || payload.intent.startDate.length === 0) {
      throw new IdempotencyError('VALIDATION', 'intent.startDate est requis (string YYYY-MM-DD).');
    }
    if (
      typeof payload.intent.endDateExclusive !== 'string' ||
      payload.intent.endDateExclusive.length === 0
    ) {
      throw new IdempotencyError(
        'VALIDATION',
        'intent.endDateExclusive est requis (string YYYY-MM-DD).',
      );
    }
  }
  if (!Array.isArray(payload.lines) || payload.lines.length === 0) {
    throw new IdempotencyError('VALIDATION', 'lines doit être un tableau non vide.');
  }
  for (const [i, line] of payload.lines.entries()) {
    if (typeof line.variantId !== 'string' || line.variantId.length === 0) {
      throw new IdempotencyError(
        'VALIDATION',
        `lines[${i}].variantId est requis (string non vide).`,
      );
    }
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new IdempotencyError(
        'VALIDATION',
        `lines[${i}].quantity doit être un entier strictement positif.`,
      );
    }
  }
}
