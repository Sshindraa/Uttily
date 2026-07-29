import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

export type DatabaseClient = ReturnType<typeof createDatabase>;

/**
 * Transaction PostgreSQL active (Drizzle). Utilisé par les fonctions de domaine
 * qui doivent s'exécuter exclusivement à l'intérieur d'une transaction explicite
 * (ex : lockKey, completeKey, failKey du module idempotency).
 */
export type DatabaseTransaction = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any
>;

/**
 * Type d'exécuteur acceptant soit un client base de données, soit une
 * transaction PostgreSQL active. Utilisé par les fonctions de domaine
 * qui peuvent être appelées à l'intérieur d'une transaction (ex : garde-fou
 * "au moins un OWNER actif" protégé par un verrou advisory).
 */
export type DbExecutor =
  | DatabaseClient
  | PgTransaction<
      PostgresJsQueryResultHKT,
      typeof schema,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any
    >;

/**
 * Crée un client Drizzle sur PostgreSQL.
 *
 * L'URL est lue depuis DATABASE_URL. En local, utiliser docker-compose.yml
 * (PostgreSQL 16 + PostGIS). En staging/production, fournie par Neon.
 */
export function createDatabase(databaseUrl: string = process.env.DATABASE_URL ?? '') {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to create a database client.');
  }
  const queryClient = postgres(databaseUrl, { max: 10 });
  return drizzle(queryClient, { schema });
}
