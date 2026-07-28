import { createDatabase, type DatabaseClient } from '@uttily/database';

let cached: DatabaseClient | null = null;

/**
 * Singleton du client base de données pour apps/web.
 * Évite de recréer un pool de connexions à chaque Server Action.
 */
export function getDb(): DatabaseClient {
  if (!cached) {
    cached = createDatabase();
  }
  return cached;
}
