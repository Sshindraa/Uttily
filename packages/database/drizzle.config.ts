import { defineConfig } from 'drizzle-kit';
import { resolveMigrationUrl } from './src/resolve-migration-url';

/**
 * Configuration Drizzle Kit (ADR-004, G5G-C).
 *
 * L'URL de migration est résolue par `resolveMigrationUrl` :
 * - priorité à DATABASE_DIRECT_URL (endpoint direct Neon, sans pooler) ;
 * - DATABASE_URL locale (localhost/127.0.0.1/::1) acceptée sans
 *   DATABASE_DIRECT_URL (développement local historique) ;
 * - DATABASE_URL distante sans DATABASE_DIRECT_URL → rejet fail-closed ;
 * - DATABASE_DIRECT_URL contenant `-pooler` → rejet (les migrations doivent
 *   utiliser l'endpoint direct) ;
 * - fallback localhost explicite si aucune variable n'est fournie.
 *
 * L'application Web, le worker et les tests métier utilisent DATABASE_URL
 * (connexion pooled côté Neon). DATABASE_DIRECT_URL est réservée aux
 * migrations et opérations administratives explicites.
 *
 * Aucune URL, mot de passe ou credential n'est journalisé.
 */
export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: resolveMigrationUrl(),
  },
  verbose: true,
  strict: true,
});
