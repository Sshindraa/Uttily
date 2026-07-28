import type { ActionErrorCode, FieldErrors } from '@uttily/contracts';

/**
 * Erreur métier typée pour le domaine catalog.
 * Les Server Actions catchent CatalogError et mappent le code vers ActionResult.
 * Évite le string matching sur les messages français.
 */
export class CatalogError extends Error {
  readonly code: ActionErrorCode;
  readonly fieldErrors?: FieldErrors | undefined;

  constructor(code: ActionErrorCode, message: string, fieldErrors?: FieldErrors) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

/**
 * Représentation minimale d'une erreur PostgreSQL levée par le driver.
 * Le code '23505' correspond à une violation de contrainte unique.
 * `constraint_name` (postgres.js) ou `constraint` (node-pg) contient le nom
 * de l'index/contrainte violé.
 */
interface PostgresError {
  code?: string;
  constraint_name?: string;
  constraint?: string;
}

/**
 * Vérifie qu'une erreur est une violation de contrainte unique PostgreSQL (23505)
 * sur la contrainte nommée. Permet de catcher les conflits par nom de contrainte
 * plutôt que par analyse du message d'erreur.
 */
function isUniqueViolation(err: unknown, constraintName: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const pgErr = err as PostgresError;
  return (
    pgErr.code === '23505' &&
    (pgErr.constraint_name === constraintName || pgErr.constraint === constraintName)
  );
}

export { isUniqueViolation };
