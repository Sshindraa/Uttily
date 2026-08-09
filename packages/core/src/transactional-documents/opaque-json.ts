/**
 * @uttily/core — Validation JSON strict récursivement (G5C, ADR-013).
 *
 * Vérifie qu'une valeur est récursivement sérialisable en JSON STRICT :
 * - primitives : boolean, string, number (fini, pas NaN/Infinity)
 * - null : OK
 * - tableaux : OK, récursivement
 * - objets : OK uniquement si prototype === Object.prototype ou === null
 * - REFUSÉS : undefined, bigint, fonction, symbol, Date, Map, Set,
 *   instances de classes, objets avec prototype personnalisé, cycles
 *
 * Factorisé ici pour éviter des implémentations divergentes entre
 * parse-snapshot, load-document-render-data et canonical-json.
 */

export function isRecursivelySerializable(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): boolean {
  if (value === null) return true;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'undefined') return false;
  if (typeof value === 'bigint') return false;
  if (typeof value === 'function') return false;
  if (typeof value === 'symbol') return false;
  if (value instanceof Date) return false;
  if (value instanceof Map) return false;
  if (value instanceof Set) return false;
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    for (const v of value) {
      if (!isRecursivelySerializable(v, seen)) return false;
    }
    seen.delete(value);
    return true;
  }
  if (typeof value === 'object') {
    // Seuls les objets plats (Object.prototype ou null) sont autorisés.
    // Map, Set, Date, class instances, etc. sont déjà refusés ci-dessus.
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) return false;
    if (seen.has(value as object)) return false;
    seen.add(value as object);
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (!isRecursivelySerializable(v, seen)) return false;
    }
    seen.delete(value as object);
    return true;
  }
  return false;
}
