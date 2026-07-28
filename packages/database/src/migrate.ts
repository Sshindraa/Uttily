import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'drizzle');

/**
 * Applique les migrations SQL explicites du Lot 1.
 *
 * Les migrations sont des fichiers .sql versionnés dans packages/database/drizzle.
 * Elles sont appliquées dans l'ordre lexicographique (préfixe 0001, 0002, ...).
 *
 * Un suivi minimal est assuré via la table `__migrations` : une migration déjà
 * appliquée n'est pas rejouée. Pour le Lot 1, ce runner est volontairement
 * simple et explicite ; drizzle-kit migrate peut aussi être utilisé.
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    await sql`CREATE TABLE IF NOT EXISTS "__migrations" (
      "id" serial PRIMARY KEY,
      "filename" text NOT NULL UNIQUE,
      "applied_at" timestamp with time zone NOT NULL DEFAULT now()
    )`;

    const files = (await readdir(MIGRATIONS_DIR)).filter(
      (f) => f.endsWith('.sql') && !f.includes('meta'),
    );
    files.sort();

    for (const file of files) {
      const already = await sql`SELECT 1 FROM "__migrations" WHERE "filename" = ${file}`;
      if (already.length > 0) continue;

      const content = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await sql.unsafe(content);
      await sql`INSERT INTO "__migrations" ("filename") VALUES (${file})`;
    }
  } finally {
    await sql.end();
  }
}
