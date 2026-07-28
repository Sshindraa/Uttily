/**
 * Helpers de validation côté Server Action.
 *
 * Validation manuelle (ADR-008) — pas de Zod à la frontière action.
 * Les parseurs FormData utilisent ces helpers pour valider UUID, enums
 * et longueurs avant de construire l'input domaine.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Vérifie qu'une chaîne est un UUID v4 valide.
 */
export function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

/**
 * Vérifie qu'une valeur fait partie d'un ensemble fermé (enum).
 */
export function isOneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return (allowed as readonly string[]).includes(value);
}
