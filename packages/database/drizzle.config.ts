import { defineConfig } from 'drizzle-kit';

/**
 * Configuration Drizzle Kit.
 *
 * La variable DATABASE_URL est lue directement depuis l'environnement.
 * En local, utiliser le fichier .env (copié depuis .env.example) ou
 * docker-compose.yml (PostgreSQL + PostGIS).
 *
 * Aucune migration métier n'est générée au Lot 0.
 */
export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://uttily:uttily@localhost:5432/uttily',
  },
  verbose: true,
  strict: true,
});
