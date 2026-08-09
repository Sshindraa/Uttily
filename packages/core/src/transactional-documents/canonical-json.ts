/**
 * @uttily/core — Sérialisation canonique JSON pour G5C (ADR-013).
 *
 * Algorithme local déterministe :
 * 1. Clés d'objets triées récursivement par ordre lexicographique UTF-16
 *    (code unit comparison, cohérent avec Array.prototype.sort default).
 * 2. Ordre des tableaux préservé après tri métier préalable (le tri métier
 *    est fait par l'appelant, canonicalJson ne re-trie pas les tableaux).
 * 3. null -> "null", boolean -> "true"/"false"
 * 4. number -> Number.isFinite requis, sérialisation via String(n)
 *    (pas de locale, pas de notation scientifique ajoutée).
 * 5. string -> JSON.stringify(s) (échappement standard JSON).
 * 6. Rejet : undefined, bigint, NaN, Infinity, -Infinity, Date, Map, Set,
 *    fonction, symbole, instances de classes, objets avec prototype
 *    personnalisé, référence circulaire. Utilise isRecursivelySerializable
 *    (opaque-json.ts) comme validateur partagé strict, garantissant la
 *    cohérence avec parseDocumentRenderSnapshotV1 et loadDocumentRenderData.
 * 7. UTF-8 déterministe : la chaîne produite est encodée en UTF-8 via
 *    TextEncoder pour les bytes finaux.
 *
 * Pas de standard cryptographique externe : algorithme local documenté.
 */

import { isRecursivelySerializable } from './opaque-json';

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

function canonicalizeValue(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError('NaN et Infinity ne sont pas autorises en canonical JSON');
    }
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'undefined') {
    throw new CanonicalJsonError('undefined n est pas autorise en canonical JSON');
  }
  if (typeof value === 'bigint') {
    throw new CanonicalJsonError('bigint n est pas autorise en canonical JSON');
  }
  if (typeof value === 'function') {
    throw new CanonicalJsonError('fonction n est pas autorisee en canonical JSON');
  }
  if (typeof value === 'symbol') {
    throw new CanonicalJsonError('symbol n est pas autorise en canonical JSON');
  }
  if (value instanceof Date) {
    throw new CanonicalJsonError('Date n est pas autorisee en canonical JSON');
  }
  if (value instanceof Map) {
    throw new CanonicalJsonError('Map n est pas autorisee en canonical JSON');
  }
  if (value instanceof Set) {
    throw new CanonicalJsonError('Set n est pas autorise en canonical JSON');
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new CanonicalJsonError('reference circulaire detectee');
    seen.add(value);
    const parts = value.map((v) => canonicalizeValue(v, seen));
    seen.delete(value);
    return '[' + parts.join(',') + ']';
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) {
      throw new CanonicalJsonError(
        'objet avec prototype non standard n est pas autorise en canonical JSON',
      );
    }
    if (seen.has(value as object)) {
      throw new CanonicalJsonError('reference circulaire detectee');
    }
    seen.add(value as object);
    const keys = Object.keys(value).sort();
    const parts = keys.map(
      (k) =>
        JSON.stringify(k) + ':' + canonicalizeValue((value as Record<string, unknown>)[k], seen),
    );
    seen.delete(value as object);
    return '{' + parts.join(',') + '}';
  }
  throw new CanonicalJsonError(`type non supporte en canonical JSON: ${typeof value}`);
}

/**
 * Sérialise une valeur en JSON canonique déterministe.
 * @returns chaîne canonique (UTF-16, encodable en UTF-8)
 */
export function canonicalJsonString(value: unknown): string {
  if (!isRecursivelySerializable(value)) {
    throw new CanonicalJsonError('valeur non serialisable en JSON strict');
  }
  return canonicalizeValue(value, new WeakSet());
}

/**
 * Sérialise une valeur en bytes UTF-8 canoniques déterministes.
 */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  const str = canonicalJsonString(value);
  return new TextEncoder().encode(str);
}
