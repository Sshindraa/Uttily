import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as schema from './schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = join(__dirname, '..', 'drizzle');

/**
 * Applique les migrations SQL via le migrateur officiel Drizzle.
 *
 * Les migrations sont des fichiers .sql versionnés dans packages/database/drizzle,
 * générés par `drizzle-kit generate` et suivis via la table `__drizzle_migrations`
 * (historique Drizzle Kit). C'est l'unique mécanisme de migration pour les
 * environnements locaux, CI, staging et production (cf. ADR-004).
 *
 * La table `__migrations` maison (Lot 1) est retirée au profit de l'autorité
 * Drizzle Kit unique.
 *
 * Le client postgres utilise `max: 1` conformément à la recommandation Drizzle
 * pour les migrations (DDL sérialisé, pas de concurrence sur le schéma).
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const migrationClient = postgres(databaseUrl, { max: 1 });
  const db = drizzle(migrationClient, { schema });
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await migrationClient.end();
  }
}
