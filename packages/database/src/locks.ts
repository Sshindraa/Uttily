import { sql } from 'drizzle-orm';
import type { DbExecutor } from './client';

/**
 * Verrou advisory transactionnel.
 *
 * Garantit la sérialisation des opérations sensibles par organisation
 * (ex : garde-fou "au moins un OWNER actif") face aux appels concurrents.
 *
 * Le verrou est pris sur un bigint dérivé de l'UUID de l'organisation :
 * on utilise les 63 bits de poids faible des 8 derniers octets de l'UUID
 * (16 caractères hexadécimaux) pour produire une clé stable par organisation.
 * Les UUID v4 étant aléatoires, le risque de collision entre organisations
 * distinctes sur ces 63 bits est négligeable (< 2^-31 pour 100k orgs).
 *
 * Le verrou est automatiquement libéré à la fin de la transaction
 * (pg_advisory_xact_lock). Il doit donc être pris À L'INTÉRIEUR d'une
 * transaction active.
 *
 * Usage :
 *   await db.transaction(async (tx) => {
 *     await lockOrganization(tx, organizationId);
 *     // ... opérations protégées ...
 *   });
 */
export async function lockOrganization(db: DbExecutor, organizationId: string): Promise<void> {
  // Dérive une clé entière 64 bits stable depuis l'UUID.
  // On utilise les 8 derniers octets de l'UUID (16 hex chars) en bigint.
  const hex = organizationId.replace(/-/g, '').slice(-16);
  const key = BigInt('0x' + hex) & (BigInt(2) ** BigInt(63) - BigInt(1));
  await db.execute(sql`SELECT pg_advisory_xact_lock(${key.toString()})`);
}
