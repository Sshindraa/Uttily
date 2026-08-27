/**
 * @uttily/core — Module Public Search (G7E-B).
 *
 * Encodage/décodage/validation du curseur keyset opaque, versionné et authentifié.
 *
 * Tuple keyset : (rawDistanceMeters, publicProductId, publicLocationId).
 * Chaque curseur est signé avec HMAC-SHA-256 et lié à une empreinte canonique de
 * la recherche (destination, locale, intent, catégorie, viewport et version du
 * contrat).
 *
 * Aucun secret codé en dur. Aucun curseur non signé n'est accepté.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PublicSearchIntent, KeysetTuple, PublicSearchViewport } from './types';
import { PublicSearchError } from './errors';
import { isValidPublicSearchViewport, normalizePublicSearchViewport } from './geo';

/** Version courante du contrat de recherche publique. */
export const PUBLIC_SEARCH_CONTRACT_VERSION = 3;

/** Version du format de curseur. */
const CURSOR_PAYLOAD_VERSION = 2;

/** Regex de validation d'un UUID (format canonique 8-4-4-4-12, insensible casse). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Empreinte canonique de la recherche à laquelle le curseur est lié.
 * Un curseur ne peut être réutilisé que si toutes ces valeurs correspondent.
 */
export interface CursorFingerprint {
  destinationPublicId: string;
  canonicalLocale: string;
  canonicalIntent: PublicSearchIntent;
  categoryId: string | null;
  /** `null` is the explicit sentinel for the canonical destination bbox. */
  viewport: PublicSearchViewport | null;
  contractVersion: number;
}

export interface PublicSearchCursorCodec {
  encode(tuple: KeysetTuple, fingerprint: CursorFingerprint): string;
  decode(cursor: string, fingerprint: CursorFingerprint): KeysetTuple;
}

/**
 * Crée un codec de curseur signé (HMAC-SHA-256).
 *
 * @param secret Secret d'au moins 32 octets (obligatoire). Jamais codé en dur.
 * @param options.contractVersion Version du contrat à exiger (défaut : PUBLIC_SEARCH_CONTRACT_VERSION).
 */
export function createPublicSearchCursorCodec(
  secret: string | Buffer,
  options?: { contractVersion?: number },
): PublicSearchCursorCodec {
  const secretBuffer = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
  if (secretBuffer.length < 32) {
    throw new PublicSearchError(
      'INVALID_CURSOR',
      'Secret de curseur trop court (minimum 32 octets).',
    );
  }
  const expectedContractVersion = options?.contractVersion ?? PUBLIC_SEARCH_CONTRACT_VERSION;

  function sign(payload: string): Buffer {
    return createHmac('sha256', secretBuffer).update(payload, 'utf8').digest();
  }

  function encode(tuple: KeysetTuple, fingerprint: CursorFingerprint): string {
    validateTuple(tuple);
    validateFingerprint(fingerprint);
    if (fingerprint.contractVersion !== expectedContractVersion) {
      throw new PublicSearchError('INVALID_CURSOR', 'Version du contrat incompatible.');
    }

    const payload = buildPayload(tuple, fingerprint);
    const signature = sign(payload);
    return `${base64UrlEncode(payload)}.${signature.toString('base64url')}`;
  }

  function decode(cursor: string, fingerprint: CursorFingerprint): KeysetTuple {
    validateFingerprint(fingerprint);
    if (fingerprint.contractVersion !== expectedContractVersion) {
      throw new PublicSearchError('INVALID_CURSOR', 'Version du contrat incompatible.');
    }

    const parts = cursor.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new PublicSearchError('INVALID_CURSOR', 'Curseur invalide.');
    }

    let payload: string;
    let receivedSig: Buffer;
    try {
      payload = base64UrlDecode(parts[0]!);
      receivedSig = Buffer.from(parts[1]!, 'base64url');
    } catch {
      throw new PublicSearchError('INVALID_CURSOR', 'Curseur invalide.');
    }

    const expectedSig = sign(payload);
    if (receivedSig.length !== expectedSig.length) {
      throw new PublicSearchError('INVALID_CURSOR', 'Curseur invalide.');
    }
    if (!timingSafeEqual(receivedSig, expectedSig)) {
      throw new PublicSearchError('INVALID_CURSOR', 'Curseur invalide.');
    }

    const parsed = parsePayload(payload);
    if (!fingerprintMatches(parsed.fingerprint, fingerprint)) {
      throw new PublicSearchError('INVALID_CURSOR', 'Curseur invalide pour cette recherche.');
    }

    return parsed.tuple;
  }

  return { encode, decode };
}

function buildPayload(tuple: KeysetTuple, fingerprint: CursorFingerprint): string {
  const obj = {
    v: CURSOR_PAYLOAD_VERSION,
    k: tuple,
    f: {
      d: fingerprint.destinationPublicId,
      l: fingerprint.canonicalLocale,
      i: canonicalIntent(fingerprint.canonicalIntent),
      c: fingerprint.categoryId,
      a: canonicalArea(fingerprint.viewport),
      cv: fingerprint.contractVersion,
    },
  };
  return canonicalJson(obj);
}

const PAYLOAD_TOP_KEYS = ['v', 'k', 'f'] as const;
const PAYLOAD_TUPLE_KEYS = ['rawDistanceMeters', 'publicProductId', 'publicLocationId'] as const;
const PAYLOAD_FINGERPRINT_KEYS = ['a', 'c', 'cv', 'd', 'i', 'l'] as const;

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || !expected.every((k, i) => actual[i] === k)) {
    throw new PublicSearchError('INVALID_CURSOR', 'Curseur invalide.');
  }
}

function parsePayload(payload: string): { tuple: KeysetTuple; fingerprint: CursorFingerprint } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new PublicSearchError('INVALID_CURSOR', 'Curseur invalide.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PublicSearchError('INVALID_CURSOR', 'Curseur invalide.');
  }

  const p = parsed as Record<string, unknown>;
  assertExactKeys(p, PAYLOAD_TOP_KEYS);

  if (p.v !== CURSOR_PAYLOAD_VERSION) {
    throw new PublicSearchError('INVALID_CURSOR', 'Version de curseur non supportée.');
  }

  const k = p.k;
  if (!k || typeof k !== 'object' || Array.isArray(k)) {
    throw new PublicSearchError('INVALID_CURSOR', 'Curseur invalide.');
  }
  const tuple = k as Record<string, unknown>;
  assertExactKeys(tuple, PAYLOAD_TUPLE_KEYS);

  const rawDistanceMeters = Number(tuple.rawDistanceMeters);
  const publicProductId = String(tuple.publicProductId ?? '');
  const publicLocationId = String(tuple.publicLocationId ?? '');

  if (!Number.isFinite(rawDistanceMeters) || rawDistanceMeters < 0) {
    throw new PublicSearchError('INVALID_CURSOR', 'Curseur invalide.');
  }
  if (!UUID_RE.test(publicProductId) || !UUID_RE.test(publicLocationId)) {
    throw new PublicSearchError('INVALID_CURSOR', 'Curseur invalide.');
  }

  const f = p.f;
  if (!f || typeof f !== 'object' || Array.isArray(f)) {
    throw new PublicSearchError('INVALID_CURSOR', 'Curseur invalide.');
  }
  const fp = f as Record<string, unknown>;
  assertExactKeys(fp, PAYLOAD_FINGERPRINT_KEYS);

  const parsedIntent = parseCanonicalIntent(fp.i);

  const fingerprint: CursorFingerprint = {
    destinationPublicId: String(fp.d ?? ''),
    canonicalLocale: String(fp.l ?? ''),
    canonicalIntent: parsedIntent,
    categoryId: fp.c === null ? null : String(fp.c ?? ''),
    viewport: parseCanonicalArea(fp.a),
    contractVersion: Number(fp.cv ?? 0),
  };

  return {
    tuple: { rawDistanceMeters, publicProductId, publicLocationId },
    fingerprint,
  };
}

function canonicalIntent(intent: PublicSearchIntent): unknown {
  if (intent.kind === 'TIME_RANGE') {
    return { k: 'T', s: intent.startAt, e: intent.endAt };
  }
  return { k: 'D', s: intent.startDate, e: intent.endDateExclusive };
}

function canonicalArea(viewport: PublicSearchViewport | null): unknown {
  if (viewport === null) return { k: 'D' };
  const normalized = normalizePublicSearchViewport(viewport);
  return {
    k: 'V',
    s: normalized.south,
    w: normalized.west,
    n: normalized.north,
    e: normalized.east,
  };
}

function parseCanonicalArea(value: unknown): PublicSearchViewport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicSearchError('INVALID_CURSOR', 'Curseur invalide.');
  }
  const area = value as Record<string, unknown>;
  if (area.k === 'D') {
    assertExactKeys(area, ['k']);
    return null;
  }
  if (area.k !== 'V') {
    throw new PublicSearchError('INVALID_CURSOR', 'Curseur invalide.');
  }
  assertExactKeys(area, ['e', 'k', 'n', 's', 'w']);
  const viewport: PublicSearchViewport = {
    kind: 'VIEWPORT',
    south: Number(area.s),
    west: Number(area.w),
    north: Number(area.n),
    east: Number(area.e),
  };
  if (!isValidPublicSearchViewport(viewport)) {
    throw new PublicSearchError('INVALID_CURSOR', 'Curseur invalide.');
  }
  return normalizePublicSearchViewport(viewport);
}

function parseCanonicalIntent(value: unknown): PublicSearchIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicSearchError('INVALID_CURSOR', 'Curseur invalide.');
  }
  const v = value as Record<string, unknown>;
  assertExactKeys(v, ['k', 's', 'e']);
  if (v.k === 'T') {
    if (typeof v.s !== 'string' || typeof v.e !== 'string') {
      throw new PublicSearchError('INVALID_CURSOR', 'Curseur invalide.');
    }
    return { kind: 'TIME_RANGE', startAt: v.s, endAt: v.e };
  }
  if (v.k === 'D') {
    if (typeof v.s !== 'string' || typeof v.e !== 'string') {
      throw new PublicSearchError('INVALID_CURSOR', 'Curseur invalide.');
    }
    return { kind: 'DAY_RANGE', startDate: v.s, endDateExclusive: v.e };
  }
  throw new PublicSearchError('INVALID_CURSOR', 'Curseur invalide.');
}

function fingerprintMatches(a: CursorFingerprint, b: CursorFingerprint): boolean {
  if (a.destinationPublicId !== b.destinationPublicId) return false;
  if (a.canonicalLocale !== b.canonicalLocale) return false;
  if (a.categoryId !== b.categoryId) return false;
  if (a.contractVersion !== b.contractVersion) return false;
  if (!sameViewport(a.viewport, b.viewport)) return false;
  if (a.canonicalIntent.kind !== b.canonicalIntent.kind) return false;
  if (a.canonicalIntent.kind === 'TIME_RANGE' && b.canonicalIntent.kind === 'TIME_RANGE') {
    return (
      a.canonicalIntent.startAt === b.canonicalIntent.startAt &&
      a.canonicalIntent.endAt === b.canonicalIntent.endAt
    );
  }
  if (a.canonicalIntent.kind === 'DAY_RANGE' && b.canonicalIntent.kind === 'DAY_RANGE') {
    return (
      a.canonicalIntent.startDate === b.canonicalIntent.startDate &&
      a.canonicalIntent.endDateExclusive === b.canonicalIntent.endDateExclusive
    );
  }
  return false;
}

function sameViewport(a: PublicSearchViewport | null, b: PublicSearchViewport | null): boolean {
  if (a === null || b === null) return a === b;
  const normalizedA = normalizePublicSearchViewport(a);
  const normalizedB = normalizePublicSearchViewport(b);
  return (
    normalizedA.south === normalizedB.south &&
    normalizedA.west === normalizedB.west &&
    normalizedA.north === normalizedB.north &&
    normalizedA.east === normalizedB.east
  );
}

function validateTuple(tuple: KeysetTuple): void {
  if (
    !tuple ||
    typeof tuple !== 'object' ||
    !Number.isFinite(tuple.rawDistanceMeters) ||
    tuple.rawDistanceMeters < 0 ||
    !UUID_RE.test(tuple.publicProductId) ||
    !UUID_RE.test(tuple.publicLocationId)
  ) {
    throw new PublicSearchError('INVALID_CURSOR', 'Tuple keyset invalide.');
  }
}

function validateFingerprint(fp: CursorFingerprint): void {
  if (!fp || typeof fp !== 'object') {
    throw new PublicSearchError('INVALID_CURSOR', 'Empreinte de curseur invalide.');
  }
  if (!UUID_RE.test(fp.destinationPublicId)) {
    throw new PublicSearchError('INVALID_CURSOR', 'destinationPublicId invalide.');
  }
  if (fp.categoryId !== null && !UUID_RE.test(fp.categoryId)) {
    throw new PublicSearchError('INVALID_CURSOR', 'categoryId invalide.');
  }
  if (fp.viewport !== null && !isValidPublicSearchViewport(fp.viewport)) {
    throw new PublicSearchError('INVALID_CURSOR', 'viewport invalide.');
  }
  if (
    typeof fp.contractVersion !== 'number' ||
    !Number.isInteger(fp.contractVersion) ||
    fp.contractVersion < 1
  ) {
    throw new PublicSearchError('INVALID_CURSOR', 'contractVersion invalide.');
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.keys(val)
          .sort()
          .reduce<Record<string, unknown>>((acc, k) => {
            acc[k] = val[k];
            return acc;
          }, {})
      : val,
  );
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str, 'utf8').toString('base64url');
}

function base64UrlDecode(str: string): string {
  return Buffer.from(str, 'base64url').toString('utf8');
}
