import { createHash } from 'node:crypto';
import { IdempotencyError } from './errors';
import type { IdempotentPayload, IdempotentPayloadLine } from './types';

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
