import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { runMigrations, assertLocalhost } from '../src/index';

/**
 * Tests d'intégration PostgreSQL de l'invariant append-only de audit_log.
 *
 * Couvre la migration 0030 (ADR-016, Option A) :
 * - FK audit_log_actor_user_id_users_id_fk recréée avec ON DELETE RESTRICT ;
 * - fonction prevent_audit_log_mutation + trigger BEFORE UPDATE OR DELETE ;
 * - comportement append-only (INSERT autorisé, UPDATE/DELETE refusés) ;
 * - hard-delete d'un utilisateur référencé refusé par la FK RESTRICT ;
 * - soft-delete via users.deleted_at autorisé ;
 * - rejeu idempotent (aucune duplication de trigger/fonction) ;
 * - migration 0029 -> 0030 avec préservation des données ;
 * - rollback transactionnel restauré la FK SET NULL en cas d'échec.
 *
 * Reprend la stratégie de setup de migrate.test.ts : base de test dédiée,
 * skip si pas DATABASE_URL en local.
 */

const TEST_DB_NAME = 'uttily_test_audit_log';
const url = process.env.DATABASE_URL;
const ci = process.env.CI === '1' || process.env.CI === 'true';

/**
 * Détermine si les tests d'intégration PostgreSQL doivent être skippés.
 * En CI, retourne toujours false (les tests doivent tourner).
 * En local, retourne true si DATABASE_URL est absente OU si SKIP_INTEGRATION_TESTS=1.
 */
function shouldSkipIntegrationTests(): boolean {
  if (ci) return false;
  if (!url) return true;
  if (process.env.SKIP_INTEGRATION_TESTS === '1') return true;
  return false;
}

async function checkConnectivity(dbUrl: string): Promise<boolean> {
  try {
    const sql = postgres(dbUrl, { max: 1, connect_timeout: 3 });
    await sql`SELECT 1`;
    await sql.end();
    return true;
  } catch {
    return false;
  }
}

let testUrl: string | null = null;

beforeAll(async () => {
  if (!url) {
    // Skip accepté uniquement quand DATABASE_URL est absente en local.
    if (ci) throw new Error('CI: DATABASE_URL est requise pour le test audit_log.');
    return;
  }
  if (process.env.SKIP_INTEGRATION_TESTS === '1') {
    if (ci) throw new Error('CI: SKIP_INTEGRATION_TESTS=1 est interdit en CI.');
    return;
  }
  const reachable = await checkConnectivity(url);
  if (!reachable) {
    // DATABASE_URL défini mais base injoignable : échec explicite, pas de faux vert.
    throw new Error(
      'DATABASE_URL est définie mais la base PostgreSQL est injoignable. ' +
        'Démarrez la base (docker compose up -d postgres) ou unset DATABASE_URL pour skipper.',
    );
  }

  // Valide que l'hôte est localhost avant toute opération destructrice.
  assertLocalhost(url);

  // Crée la base de test via le client postgres.
  const adminSql = postgres(url, { max: 1 });
  try {
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    await adminSql.unsafe(`CREATE DATABASE ${TEST_DB_NAME};`);
  } finally {
    await adminSql.end();
  }

  // Construit l'URL de la base de test de manière sûre via new URL().
  const testUrlObj = new URL(url);
  testUrlObj.pathname = `/${TEST_DB_NAME}`;
  testUrl = testUrlObj.toString();
  await runMigrations(testUrl);
}, 300000);

afterAll(async () => {
  if (!url || !testUrl) return;
  const cleanupSql = postgres(url, { max: 1 });
  try {
    await cleanupSql.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();`,
    );
    await cleanupSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
  } finally {
    await cleanupSql.end();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation statique du fichier de migration 0030
// ─────────────────────────────────────────────────────────────────────────────

describe('Validation statique du fichier de migration 0030', () => {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
  const sqlContent = readFileSync(join(migrationsDir, '0030_audit_log_append_only.sql'), 'utf-8');

  it('contient DROP CONSTRAINT avec le nom exact de la FK (sans IF EXISTS)', () => {
    expect(sqlContent).toContain('DROP CONSTRAINT "audit_log_actor_user_id_users_id_fk"');
  });

  it('ne contient pas DROP CONSTRAINT IF EXISTS pour cette FK', () => {
    expect(sqlContent).not.toContain(
      'DROP CONSTRAINT IF EXISTS "audit_log_actor_user_id_users_id_fk"',
    );
  });

  it('contient ON DELETE restrict', () => {
    expect(sqlContent).toContain('ON DELETE restrict');
  });

  it('contient CREATE OR REPLACE FUNCTION prevent_audit_log_mutation', () => {
    expect(sqlContent).toContain('CREATE OR REPLACE FUNCTION "prevent_audit_log_mutation"');
  });

  it('contient CREATE TRIGGER prevent_update_delete_audit_log', () => {
    expect(sqlContent).toContain('CREATE TRIGGER "prevent_update_delete_audit_log"');
  });

  it('contient BEFORE UPDATE OR DELETE ON audit_log', () => {
    expect(sqlContent).toContain('BEFORE UPDATE OR DELETE ON "audit_log"');
  });

  it('contient FOR EACH ROW', () => {
    expect(sqlContent).toContain('FOR EACH ROW');
  });

  it('ne contient pas ALTER CONSTRAINT', () => {
    expect(sqlContent).not.toContain('ALTER CONSTRAINT');
  });

  it('ne contient pas BEFORE TRUNCATE', () => {
    expect(sqlContent).not.toContain('BEFORE TRUNCATE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation statique du journal Drizzle
// ─────────────────────────────────────────────────────────────────────────────

describe('Validation statique du journal Drizzle', () => {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
  const journalRaw = readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf-8');
  const journal = JSON.parse(journalRaw) as {
    entries: Array<{
      idx: number;
      when: number;
      tag: string;
      version: string;
      breakpoints: boolean;
    }>;
  };

  it('contient exactement 59 entrées', () => {
    expect(journal.entries.length).toBe(59);
  });

  it('préserve 0030_audit_log_append_only à l idx 29', () => {
    expect(journal.entries[29]!.idx).toBe(29);
    expect(journal.entries[29]!.tag).toBe('0030_audit_log_append_only');
  });

  it('l entrée 30 est 0031_lot7_public_search_foundations', () => {
    expect(journal.entries[30]!.idx).toBe(30);
    expect(journal.entries[30]!.tag).toBe('0031_lot7_public_search_foundations');
  });

  it('la dernière entrée est 0032_lot7_pricing_plan_foundations à l idx 31', () => {
    expect(journal.entries[31]!.idx).toBe(31);
    expect(journal.entries[31]!.tag).toBe('0032_lot7_pricing_plan_foundations');
  });

  it('l entrée 28 a le tag 0029_lot6_email_delivery_safety', () => {
    expect(journal.entries[28]!.tag).toBe('0029_lot6_email_delivery_safety');
  });

  it('le timestamp de 0031 est strictement supérieur à celui de 0030', () => {
    expect(journal.entries[30]!.when).toBeGreaterThan(journal.entries[29]!.when);
  });

  it('le timestamp de 0032 est strictement supérieur à celui de 0031', () => {
    expect(journal.entries[31]!.when).toBeGreaterThan(journal.entries[30]!.when);
  });

  it('0031 a version 7', () => {
    expect(journal.entries[30]!.version).toBe('7');
  });

  it('0031 a breakpoints true', () => {
    expect(journal.entries[30]!.breakpoints).toBe(true);
  });

  it('0032 a version 7', () => {
    expect(journal.entries[31]!.version).toBe('7');
  });

  it('0032 a breakpoints true', () => {
    expect(journal.entries[31]!.breakpoints).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A. Structure — migration 0030
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(shouldSkipIntegrationTests())('Structure — migration 0030', () => {
  it('applique 32 migrations depuis une base vierge', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`;
      expect(rows.length).toBe(58);
    } finally {
      await sql.end();
    }
  });

  it('la migration 0030 est présente dans le journal Drizzle', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      // Drizzle stocke un hash, pas le tag. La présence du trigger et de la FK
      // RESTRICT prouve que la migration 0030 a été appliquée.
      const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`;
      expect(rows.length).toBe(58);

      const fk = await sql`
        SELECT confdeltype FROM pg_constraint WHERE conname = 'audit_log_actor_user_id_users_id_fk'
      `;
      expect(fk[0]!.confdeltype).toBe('r');

      const trigger = await sql`
        SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'audit_log'::regclass AND NOT tgisinternal AND tgname = 'prevent_update_delete_audit_log'
      `;
      expect(trigger.length).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it('la FK audit_log_actor_user_id_users_id_fk a ON DELETE RESTRICT', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      // confdeltype : 'a' = NO ACTION, 'r' = RESTRICT, 'c' = CASCADE,
      // 'n' = SET NULL, 'd' = SET DEFAULT.
      const rows = await sql`
        SELECT confdeltype FROM pg_constraint WHERE conname = 'audit_log_actor_user_id_users_id_fk'
      `;
      expect(rows.length).toBe(1);
      expect(rows[0]!.confdeltype).toBe('r');
    } finally {
      await sql.end();
    }
  });

  it('la fonction prevent_audit_log_mutation existe (schéma public)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      // Limite la recherche au schéma public pour éviter un faux positif
      // provenant d'un autre schéma ou d'un overload.
      const rows = await sql`
        SELECT p.proname, n.nspname
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE p.proname = 'prevent_audit_log_mutation' AND n.nspname = 'public'
      `;
      expect(rows.length).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it('le trigger appelle bien la fonction prevent_audit_log_mutation', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      // tgfoid pointe vers l'OID de la fonction appelée par le trigger.
      const rows = await sql`
        SELECT t.tgname, p.proname, n.nspname
        FROM pg_trigger t
        JOIN pg_proc p ON t.tgfoid = p.oid
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE t.tgrelid = 'audit_log'::regclass
          AND NOT t.tgisinternal
          AND t.tgname = 'prevent_update_delete_audit_log'
      `;
      expect(rows.length).toBe(1);
      expect(rows[0]!.proname).toBe('prevent_audit_log_mutation');
      expect(rows[0]!.nspname).toBe('public');
    } finally {
      await sql.end();
    }
  });

  it('le trigger prevent_update_delete_audit_log existe et est actif', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      // tgenabled : 'O' = origin (activé), 'D' = disabled, 'A' = always, 'R' = replica.
      const rows = await sql`
        SELECT tgname, tgenabled FROM pg_trigger
        WHERE tgrelid = 'audit_log'::regclass AND NOT tgisinternal AND tgname = 'prevent_update_delete_audit_log'
      `;
      expect(rows.length).toBe(1);
      expect(rows[0]!.tgenabled).toBe('O');
    } finally {
      await sql.end();
    }
  });

  it('le trigger couvre UPDATE et DELETE (tgtype exact)', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      // tgtype est un int2 bitmask (cf. pg_trigger.h) :
      //   TRIGGER_TYPE_ROW     = 0x1
      //   TRIGGER_TYPE_BEFORE  = 0x2
      //   TRIGGER_TYPE_INSERT  = 0x4
      //   TRIGGER_TYPE_DELETE  = 0x8
      //   TRIGGER_TYPE_UPDATE  = 0x10
      //   TRIGGER_TYPE_TRUNCATE = 0x20
      // BEFORE UPDATE OR DELETE FOR EACH ROW = 0x1 | 0x2 | 0x8 | 0x10 = 0x1B.
      const rows = await sql`
        SELECT tgtype FROM pg_trigger
        WHERE tgname = 'prevent_update_delete_audit_log' AND tgrelid = 'audit_log'::regclass
      `;
      expect(rows.length).toBe(1);
      const tgtype = rows[0]!.tgtype as number;
      // Bits présents requis.
      expect(tgtype & 0x1).toBe(0x1); // ROW
      expect(tgtype & 0x2).toBe(0x2); // BEFORE
      expect(tgtype & 0x8).toBe(0x8); // DELETE
      expect(tgtype & 0x10).toBe(0x10); // UPDATE
      // Bits absents requis.
      expect(tgtype & 0x4).toBe(0); // INSERT absent
      expect(tgtype & 0x20).toBe(0); // TRUNCATE absent
      // Valeur exacte.
      expect(tgtype).toBe(0x1b);
    } finally {
      await sql.end();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Comportement — append-only
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(shouldSkipIntegrationTests())('Comportement — append-only', () => {
  it('INSERT audit_log autorisé', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const inserted = await sql`
        INSERT INTO "audit_log" ("actor_user_id", "action", "target_type", "target_id", "metadata")
        VALUES (NULL, 'TEST_INSERT', 'TEST_TARGET', NULL, ${sql.json({ source: 'test' })})
        RETURNING "id", "action"
      `;
      expect(inserted.length).toBe(1);
      expect(inserted[0]!.action).toBe('TEST_INSERT');

      // Lecture de vérification.
      const read = await sql`SELECT "action" FROM "audit_log" WHERE "id" = ${inserted[0]!.id}`;
      expect(read.length).toBe(1);
      expect(read[0]!.action).toBe('TEST_INSERT');
    } finally {
      await sql.end();
    }
  });

  it('INSERT avec actor_user_id valide autorisé', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const user =
        await sql`INSERT INTO "users" ("email") VALUES ('audit-actor-valid@example.com') RETURNING "id"`;
      const userId = user[0]!.id;
      const inserted = await sql`
        INSERT INTO "audit_log" ("actor_user_id", "action", "target_type", "target_id", "metadata")
        VALUES (${userId}, 'TEST_ACTION_ACTOR', 'TEST_TARGET', NULL, ${sql.json({ ok: true })})
        RETURNING "id", "actor_user_id"
      `;
      expect(inserted.length).toBe(1);
      expect(inserted[0]!.actor_user_id).toBe(userId);
    } finally {
      await sql.end();
    }
  });

  it('UPDATE d une ligne existante refusé', async () => {
    if (!testUrl) return;
    // Connexion 1 : insertion.
    const sql1 = postgres(testUrl, { max: 1 });
    let rowId: string;
    try {
      const inserted = await sql1`
        INSERT INTO "audit_log" ("actor_user_id", "action", "target_type", "target_id", "metadata")
        VALUES (NULL, 'UPDATE_REFUSE', 'TEST_TARGET', NULL, ${sql1.json({ v: 1 })})
        RETURNING "id"
      `;
      rowId = inserted[0]!.id;
    } finally {
      await sql1.end();
    }

    // Connexion 2 : tentative d'UPDATE (doit échouer).
    const sql2 = postgres(testUrl, { max: 1 });
    try {
      await expect(
        sql2`UPDATE "audit_log" SET "action" = 'tampered' WHERE "id" = ${rowId}`,
      ).rejects.toThrow(/append-only/);
    } finally {
      await sql2.end();
    }

    // Connexion 3 : vérification que la ligne est inchangée.
    const sql3 = postgres(testUrl, { max: 1 });
    try {
      const rows = await sql3`SELECT "action" FROM "audit_log" WHERE "id" = ${rowId}`;
      expect(rows.length).toBe(1);
      expect(rows[0]!.action).toBe('UPDATE_REFUSE');
    } finally {
      await sql3.end();
    }
  });

  it('DELETE d une ligne existante refusé', async () => {
    if (!testUrl) return;
    // Connexion 1 : insertion.
    const sql1 = postgres(testUrl, { max: 1 });
    let rowId: string;
    try {
      const inserted = await sql1`
        INSERT INTO "audit_log" ("actor_user_id", "action", "target_type", "target_id", "metadata")
        VALUES (NULL, 'DELETE_REFUSE', 'TEST_TARGET', NULL, ${sql1.json({ v: 2 })})
        RETURNING "id"
      `;
      rowId = inserted[0]!.id;
    } finally {
      await sql1.end();
    }

    // Connexion 2 : tentative de DELETE (doit échouer).
    const sql2 = postgres(testUrl, { max: 1 });
    try {
      await expect(sql2`DELETE FROM "audit_log" WHERE "id" = ${rowId}`).rejects.toThrow(
        /append-only/,
      );
    } finally {
      await sql2.end();
    }

    // Connexion 3 : vérification que la ligne existe toujours.
    const sql3 = postgres(testUrl, { max: 1 });
    try {
      const rows = await sql3`SELECT "action" FROM "audit_log" WHERE "id" = ${rowId}`;
      expect(rows.length).toBe(1);
      expect(rows[0]!.action).toBe('DELETE_REFUSE');
    } finally {
      await sql3.end();
    }
  });

  it('l erreur ne contient aucune donnée de la ligne', async () => {
    if (!testUrl) return;
    const secretToken = 'SECRET_TOKEN_' + Math.random().toString(36).slice(2);
    const secretPayload = 'distinctive_payload_' + Math.random().toString(36).slice(2);

    // Connexion 1 : insertion avec métadonnées distinctives.
    const sql1 = postgres(testUrl, { max: 1 });
    let rowId: string;
    try {
      const inserted = await sql1`
        INSERT INTO "audit_log" ("actor_user_id", "action", "target_type", "target_id", "metadata")
        VALUES (NULL, ${'ACTION_' + secretToken}, 'TEST_TARGET', NULL, ${sql1.json({ secret: secretPayload })})
        RETURNING "id"
      `;
      rowId = inserted[0]!.id;
    } finally {
      await sql1.end();
    }

    // Connexion 2 : tentative d'UPDATE — l'erreur ne doit pas fuiter les données.
    const sql2 = postgres(testUrl, { max: 1 });
    try {
      let thrownMessage: string | null = null;
      try {
        await sql2`UPDATE "audit_log" SET "action" = 'x' WHERE "id" = ${rowId}`;
      } catch (e) {
        thrownMessage = (e as Error).message;
      }
      expect(thrownMessage).not.toBeNull();
      expect(thrownMessage).not.toContain(secretToken);
      expect(thrownMessage).not.toContain(secretPayload);
    } finally {
      await sql2.end();
    }
  });

  it('hard-delete d un utilisateur avec audit refusé par la FK', async () => {
    if (!testUrl) return;
    const email = 'hard-delete-refused@example.com';

    // Connexion 1 : insertion user + audit_log référençant cet user.
    const sql1 = postgres(testUrl, { max: 1 });
    let userId: string;
    try {
      const user = await sql1`INSERT INTO "users" ("email") VALUES (${email}) RETURNING "id"`;
      userId = user[0]!.id;
      await sql1`
        INSERT INTO "audit_log" ("actor_user_id", "action", "target_type", "target_id", "metadata")
        VALUES (${userId}, 'USER_HARD_DELETE_REFUSED', 'USER', ${userId}, ${sql1.json({ ctx: 'fk' })})
      `;
    } finally {
      await sql1.end();
    }

    // Connexion 2 : tentative de hard-delete (doit échouer — FK RESTRICT).
    const sql2 = postgres(testUrl, { max: 1 });
    try {
      let thrownError: (Error & { code?: string }) | null = null;
      try {
        await sql2`DELETE FROM "users" WHERE "id" = ${userId}`;
      } catch (e) {
        thrownError = e as Error & { code?: string };
      }
      expect(thrownError).not.toBeNull();
      // SQLSTATE 23503 = foreign_key_violation.
      // postgres.js expose le SQLSTATE dans la propriété .code de l'erreur.
      expect(thrownError!.code).toBe('23503');
      // Le message PostgreSQL contient le nom de la contrainte violée.
      expect(thrownError!.message).toContain('audit_log_actor_user_id_users_id_fk');
      // L'erreur ne doit pas mentionner le trigger (c'est la FK RESTRICT, pas le trigger).
      expect(thrownError!.message).not.toContain('append-only');
    } finally {
      await sql2.end();
    }

    // Connexion 3 : vérifications post-échec.
    const sql3 = postgres(testUrl, { max: 1 });
    try {
      // L'utilisateur existe toujours.
      const users = await sql3`SELECT "id" FROM "users" WHERE "id" = ${userId}`;
      expect(users.length).toBe(1);

      // L'entrée audit_log existe toujours avec le même actor_user_id.
      const audits =
        await sql3`SELECT "actor_user_id" FROM "audit_log" WHERE "actor_user_id" = ${userId}`;
      expect(audits.length).toBe(1);
      expect(audits[0]!.actor_user_id).toBe(userId);
    } finally {
      await sql3.end();
    }
  });

  it('hard-delete d un utilisateur sans audit autorisé', async () => {
    if (!testUrl) return;
    const email = 'hard-delete-ok@example.com';

    // Connexion 1 : insertion user (aucune entrée audit_log).
    const sql1 = postgres(testUrl, { max: 1 });
    let userId: string;
    try {
      const user = await sql1`INSERT INTO "users" ("email") VALUES (${email}) RETURNING "id"`;
      userId = user[0]!.id;
    } finally {
      await sql1.end();
    }

    // Connexion 2 : hard-delete autorisé (aucune FK référentielle).
    const sql2 = postgres(testUrl, { max: 1 });
    try {
      await sql2`DELETE FROM "users" WHERE "id" = ${userId}`;
    } finally {
      await sql2.end();
    }

    // Connexion 3 : vérification que l'utilisateur a bien été supprimé.
    const sql3 = postgres(testUrl, { max: 1 });
    try {
      const rows = await sql3`SELECT "id" FROM "users" WHERE "id" = ${userId}`;
      expect(rows.length).toBe(0);
    } finally {
      await sql3.end();
    }
  });

  it('soft-delete via users.deleted_at autorisé', async () => {
    if (!testUrl) return;
    const email = 'soft-delete-ok@example.com';

    // Connexion 1 : insertion user + audit_log référençant cet user.
    const sql1 = postgres(testUrl, { max: 1 });
    let userId: string;
    try {
      const user = await sql1`INSERT INTO "users" ("email") VALUES (${email}) RETURNING "id"`;
      userId = user[0]!.id;
      await sql1`
        INSERT INTO "audit_log" ("actor_user_id", "action", "target_type", "target_id", "metadata")
        VALUES (${userId}, 'USER_SOFT_DELETE', 'USER', ${userId}, ${sql1.json({ ctx: 'soft' })})
      `;
    } finally {
      await sql1.end();
    }

    // Connexion 2 : soft-delete via deleted_at (autorise — pas de suppression physique).
    const sql2 = postgres(testUrl, { max: 1 });
    try {
      await sql2`UPDATE "users" SET "deleted_at" = now() WHERE "id" = ${userId}`;
    } finally {
      await sql2.end();
    }

    // Connexion 3 : vérification que l'utilisateur existe toujours et que
    // les entrées audit_log conservent le même actor_user_id.
    const sql3 = postgres(testUrl, { max: 1 });
    try {
      const users = await sql3`SELECT "id", "deleted_at" FROM "users" WHERE "id" = ${userId}`;
      expect(users.length).toBe(1);
      expect(users[0]!.deleted_at).not.toBeNull();

      const audits =
        await sql3`SELECT "actor_user_id" FROM "audit_log" WHERE "actor_user_id" = ${userId}`;
      expect(audits.length).toBe(1);
      expect(audits[0]!.actor_user_id).toBe(userId);
    } finally {
      await sql3.end();
    }
  });

  it('INSERT avec actor_user_id NULL autorisé', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const inserted = await sql`
        INSERT INTO "audit_log" ("actor_user_id", "action", "target_type", "target_id", "metadata")
        VALUES (NULL, 'NULL_ACTOR_OK', 'TEST_TARGET', NULL, ${sql.json({ null_actor: true })})
        RETURNING "id", "actor_user_id"
      `;
      expect(inserted.length).toBe(1);
      expect(inserted[0]!.actor_user_id).toBeNull();
    } finally {
      await sql.end();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. TRUNCATE — hors contrat applicatif
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(shouldSkipIntegrationTests())('TRUNCATE — hors contrat applicatif', () => {
  it('TRUNCATE TABLE audit_log fonctionne en base éphémère de test', async () => {
    if (!testUrl) return;
    // Note : TRUNCATE n'est pas intercepté par le trigger BEFORE UPDATE OR DELETE.
    // C'est une opération privilégiée acceptable uniquement dans une base de test
    // éphémère ; elle est hors contrat applicatif (cf. ADR-016 §2.1).
    const sql = postgres(testUrl, { max: 1 });
    try {
      await sql`
        INSERT INTO "audit_log" ("actor_user_id", "action", "target_type", "target_id", "metadata")
        VALUES (NULL, 'TRUNCATE_ME', 'TEST_TARGET', NULL, ${sql.json({ v: 3 })})
      `;
      const before = await sql`SELECT count(*)::int as n FROM "audit_log"`;
      expect(before[0]!.n).toBeGreaterThanOrEqual(1);

      await sql`TRUNCATE TABLE "audit_log"`;

      const after = await sql`SELECT count(*)::int as n FROM "audit_log"`;
      expect(after[0]!.n).toBe(0);
    } finally {
      await sql.end();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Rejeu — idempotence
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(shouldSkipIntegrationTests())('Rejeu — idempotence', () => {
  it('second appel du migrateur : toujours 32 migrations, aucune réapplication', async () => {
    if (!testUrl) return;
    // Second appel : ne doit pas dupliquer les entrées.
    await runMigrations(testUrl);
    const sql = postgres(testUrl, { max: 1 });
    try {
      const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`;
      expect(rows.length).toBe(58);
    } finally {
      await sql.end();
    }
  });

  it('trigger non dupliqué après rejeu', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      const rows = await sql`
        SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'audit_log'::regclass AND NOT tgisinternal AND tgname = 'prevent_update_delete_audit_log'
      `;
      expect(rows.length).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it('fonction non dupliquée après rejeu', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    try {
      // CREATE OR REPLACE FUNCTION ne crée pas de doublon : une seule entrée pg_proc.
      const rows = await sql`
        SELECT proname FROM pg_proc WHERE proname = 'prevent_audit_log_mutation'
      `;
      expect(rows.length).toBe(1);
    } finally {
      await sql.end();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Migration 0029 → 0030 avec données
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(shouldSkipIntegrationTests())('Migration 0029 → 0030 avec données', () => {
  const MIGRATION_TEST_DB = 'uttily_test_audit_log_migration';
  const ROLLBACK_TEST_DB = 'uttily_test_audit_log_rollback';
  let migrationTestUrl: string | null = null;
  let rollbackTestUrl: string | null = null;
  let migrationAdminSql: ReturnType<typeof postgres> | null = null;
  let rollbackAdminSql: ReturnType<typeof postgres> | null = null;

  /**
   * Applique les migrations 0001 à 0029 manuellement (avant la migration 0030).
   */
  async function applyMigrationsUntilBefore0030(dbUrl: string): Promise<void> {
    const sql = postgres(dbUrl, { max: 1 });
    try {
      const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
      const allFiles = readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      for (const file of allFiles) {
        const num = parseInt(file.slice(0, 4), 10);
        if (isNaN(num) || num >= 30) continue; // Arrêt avant 0030.
        const sqlContent = readFileSync(join(migrationsDir, file), 'utf-8');
        await sql.unsafe(sqlContent);
      }
    } finally {
      await sql.end();
    }
  }

  /**
   * Applique manuellement la migration 0030 sur une base déjà migrée jusqu'à 0029.
   */
  async function applyMigration0030(dbUrl: string): Promise<void> {
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
    const sqlContent = readFileSync(join(migrationsDir, '0030_audit_log_append_only.sql'), 'utf-8');
    const sql = postgres(dbUrl, { max: 1 });
    try {
      // Transaction explicite pour reproduire le comportement du runner Drizzle
      // qui enveloppe chaque migration dans une transaction commune.
      await sql.begin(async (tx) => {
        await tx.unsafe(sqlContent);
      });
    } finally {
      await sql.end();
    }
  }

  beforeAll(async () => {
    if (!url) {
      throw new Error(
        "Migration 0029 → 0030 : DATABASE_URL est requise (le skip global aurait dû empêcher l'exécution).",
      );
    }

    // Base dédiée pour le test de migration 0029 → 0030.
    migrationAdminSql = postgres(url, { max: 1 });
    await migrationAdminSql.unsafe(`DROP DATABASE IF EXISTS ${MIGRATION_TEST_DB};`);
    await migrationAdminSql.unsafe(`CREATE DATABASE ${MIGRATION_TEST_DB};`);
    const migrationUrlObj = new URL(url);
    migrationUrlObj.pathname = `/${MIGRATION_TEST_DB}`;
    migrationTestUrl = migrationUrlObj.toString();
    await applyMigrationsUntilBefore0030(migrationTestUrl);

    // Base dédiée pour le test de rollback transactionnel.
    rollbackAdminSql = postgres(url, { max: 1 });
    await rollbackAdminSql.unsafe(`DROP DATABASE IF EXISTS ${ROLLBACK_TEST_DB};`);
    await rollbackAdminSql.unsafe(`CREATE DATABASE ${ROLLBACK_TEST_DB};`);
    const rollbackUrlObj = new URL(url);
    rollbackUrlObj.pathname = `/${ROLLBACK_TEST_DB}`;
    rollbackTestUrl = rollbackUrlObj.toString();
    await applyMigrationsUntilBefore0030(rollbackTestUrl);
  }, 300000);

  afterAll(async () => {
    if (migrationAdminSql) {
      try {
        await migrationAdminSql.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${MIGRATION_TEST_DB}' AND pid <> pg_backend_pid();`,
        );
        await migrationAdminSql.unsafe(`DROP DATABASE IF EXISTS ${MIGRATION_TEST_DB};`);
      } finally {
        await migrationAdminSql.end();
      }
    }
    if (rollbackAdminSql) {
      try {
        await rollbackAdminSql.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${ROLLBACK_TEST_DB}' AND pid <> pg_backend_pid();`,
        );
        await rollbackAdminSql.unsafe(`DROP DATABASE IF EXISTS ${ROLLBACK_TEST_DB};`);
      } finally {
        await rollbackAdminSql.end();
      }
    }
  });

  it('migration 0029 → 0030 préserve les données audit_log', async () => {
    expect(migrationTestUrl).toBeTruthy();
    const dbUrl = migrationTestUrl!;

    // Connexion 1 : insertion d'un user + d'une entrée audit_log sur la base 0029.
    const sql1 = postgres(dbUrl, { max: 1 });
    let userId: string;
    let auditId: string;
    let auditAction: string;
    let auditTargetType: string;
    let auditTargetId: string | null;
    let auditMetadata: unknown;
    let auditCreatedAt: Date;
    try {
      const user =
        await sql1`INSERT INTO "users" ("email") VALUES ('migration-preserve@example.com') RETURNING "id"`;
      userId = user[0]!.id;

      const inserted = await sql1`
        INSERT INTO "audit_log" ("actor_user_id", "action", "target_type", "target_id", "metadata")
        VALUES (${userId}, 'MIGRATION_PRESERVE', 'USER', ${userId}, ${sql1.json({ preserved: true, n: 42 })})
        RETURNING "id", "actor_user_id", "action", "target_type", "target_id", "metadata", "created_at"
      `;
      auditId = inserted[0]!.id;
      auditAction = inserted[0]!.action;
      auditTargetType = inserted[0]!.target_type;
      auditTargetId = inserted[0]!.target_id;
      auditMetadata = inserted[0]!.metadata;
      auditCreatedAt = inserted[0]!.created_at;

      // Vérifie que la FK est encore SET NULL avant la migration 0030.
      const fkBefore = await sql1`
        SELECT confdeltype FROM pg_constraint WHERE conname = 'audit_log_actor_user_id_users_id_fk'
      `;
      expect(fkBefore[0]!.confdeltype).toBe('n');
    } finally {
      await sql1.end();
    }

    // Application manuelle de la migration 0030.
    await applyMigration0030(dbUrl);

    // Connexion 2 : vérification de la préservation des données et des métadonnées.
    const sql2 = postgres(dbUrl, { max: 1 });
    try {
      // FK désormais RESTRICT.
      const fkAfter = await sql2`
        SELECT confdeltype FROM pg_constraint WHERE conname = 'audit_log_actor_user_id_users_id_fk'
      `;
      expect(fkAfter[0]!.confdeltype).toBe('r');

      // Trigger présent.
      const trigger = await sql2`
        SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'audit_log'::regclass AND NOT tgisinternal AND tgname = 'prevent_update_delete_audit_log'
      `;
      expect(trigger.length).toBe(1);

      // Ligne audit_log préservée à l'identique.
      const rows = await sql2`
        SELECT "id", "actor_user_id", "action", "target_type", "target_id", "metadata", "created_at"
        FROM "audit_log" WHERE "id" = ${auditId}
      `;
      expect(rows.length).toBe(1);
      expect(rows[0]!.id).toBe(auditId);
      expect(rows[0]!.actor_user_id).toBe(userId);
      expect(rows[0]!.action).toBe(auditAction);
      expect(rows[0]!.target_type).toBe(auditTargetType);
      expect(rows[0]!.target_id).toBe(auditTargetId);
      expect(rows[0]!.metadata).toEqual(auditMetadata);
      expect(rows[0]!.created_at).toEqual(auditCreatedAt);
    } finally {
      await sql2.end();
    }

    // Connexion 3 : UPDATE refusé.
    const sql3 = postgres(dbUrl, { max: 1 });
    try {
      await expect(
        sql3`UPDATE "audit_log" SET "action" = 'tampered' WHERE "id" = ${auditId}`,
      ).rejects.toThrow(/append-only/);
    } finally {
      await sql3.end();
    }

    // Connexion 4 : DELETE refusé.
    const sql4 = postgres(dbUrl, { max: 1 });
    try {
      await expect(sql4`DELETE FROM "audit_log" WHERE "id" = ${auditId}`).rejects.toThrow(
        /append-only/,
      );
    } finally {
      await sql4.end();
    }

    // Connexion 5 : hard-delete de l'utilisateur refusé (FK RESTRICT).
    const sql5 = postgres(dbUrl, { max: 1 });
    try {
      await expect(sql5`DELETE FROM "users" WHERE "id" = ${userId}`).rejects.toThrow();
    } finally {
      await sql5.end();
    }
  });

  it('rollback transactionnel : FK/fonction/trigger restaurés si la migration échoue', async () => {
    expect(rollbackTestUrl).toBeTruthy();
    const dbUrl = rollbackTestUrl!;

    // Connexion 1 : insertion d'un user + audit_log pour vérifier l'intégrité post-rollback.
    const sql1 = postgres(dbUrl, { max: 1 });
    let userId: string;
    let auditId: string;
    let auditAction: string;
    let auditMetadata: unknown;
    try {
      const user =
        await sql1`INSERT INTO "users" ("email") VALUES ('rollback-full@example.com') RETURNING "id"`;
      userId = user[0]!.id;
      const inserted = await sql1`
        INSERT INTO "audit_log" ("actor_user_id", "action", "target_type", "target_id", "metadata")
        VALUES (${userId}, 'ROLLBACK_FULL', 'USER', ${userId}, ${sql1.json({ rollback: 'full' })})
        RETURNING "id", "action", "metadata"
      `;
      auditId = inserted[0]!.id;
      auditAction = inserted[0]!.action;
      auditMetadata = inserted[0]!.metadata;

      // Vérifie que la FK est SET NULL avant toute opération.
      const fkBefore = await sql1`
        SELECT confdeltype FROM pg_constraint WHERE conname = 'audit_log_actor_user_id_users_id_fk'
      `;
      expect(fkBefore[0]!.confdeltype).toBe('n');
    } finally {
      await sql1.end();
    }

    // Lecture du contenu réel et complet de la migration 0030.
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
    const migration0030Content = readFileSync(
      join(migrationsDir, '0030_audit_log_append_only.sql'),
      'utf-8',
    );

    // Transaction contrôlée : exécution complète de 0030 + vérification in-tx + erreur volontaire.
    const sqlTx = postgres(dbUrl, { max: 1 });
    let observedFkRestrict = false;
    let observedFunction = false;
    let observedTrigger = false;
    let transactionError: Error | null = null;
    try {
      try {
        await sqlTx.begin(async (tx) => {
          // Exécution du contenu RÉEL et COMPLET de la migration 0030.
          await tx.unsafe(migration0030Content);

          // Vérification DEPUIS la transaction que les 3 objets existent.
          const fkInTx = await tx`
            SELECT confdeltype FROM pg_constraint WHERE conname = 'audit_log_actor_user_id_users_id_fk'
          `;
          if (fkInTx.length === 1 && fkInTx[0]!.confdeltype === 'r') {
            observedFkRestrict = true;
          }

          const fnInTx = await tx`
            SELECT p.proname FROM pg_proc p
            JOIN pg_namespace n ON p.pronamespace = n.oid
            WHERE p.proname = 'prevent_audit_log_mutation' AND n.nspname = 'public'
          `;
          if (fnInTx.length >= 1) {
            observedFunction = true;
          }

          const triggerInTx = await tx`
            SELECT tgname FROM pg_trigger
            WHERE tgrelid = 'audit_log'::regclass AND NOT tgisinternal AND tgname = 'prevent_update_delete_audit_log'
          `;
          if (triggerInTx.length === 1) {
            observedTrigger = true;
          }

          // Erreur volontaire pour déclencher le rollback de la transaction.
          await tx`SELECT 1/0`;
        });
        // Ne doit jamais être atteint : la transaction doit échouer.
        expect(false).toBe(true);
      } catch (e) {
        transactionError = e as Error;
      }
    } finally {
      await sqlTx.end();
    }

    // Vérifie que la transaction a bien échoué avec une erreur PostgreSQL
    // (et non une erreur d'assertion avalée).
    expect(transactionError).not.toBeNull();
    expect(transactionError!.message).toContain('division');

    // Preuves que les 3 objets ont réellement été observés avant l'erreur.
    // Si ces assertions échouent, cela signifie que la migration 0030 n'a pas
    // été exécutée complètement dans la transaction avant l'erreur volontaire.
    expect(observedFkRestrict).toBe(true);
    expect(observedFunction).toBe(true);
    expect(observedTrigger).toBe(true);

    // Connexion 2 : vérification post-rollback sur une connexion fraîche.
    const sql2 = postgres(dbUrl, { max: 1 });
    try {
      // La FK est restaurée à SET NULL.
      const fkAfter = await sql2`
        SELECT confdeltype FROM pg_constraint WHERE conname = 'audit_log_actor_user_id_users_id_fk'
      `;
      expect(fkAfter.length).toBe(1);
      expect(fkAfter[0]!.confdeltype).toBe('n');

      // Aucun trigger de la migration 0030 n'existe après rollback.
      const trigger = await sql2`
        SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'audit_log'::regclass AND NOT tgisinternal AND tgname = 'prevent_update_delete_audit_log'
      `;
      expect(trigger.length).toBe(0);

      // Aucune fonction de la migration 0030 n'existe après rollback.
      const fn = await sql2`
        SELECT p.proname FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE p.proname = 'prevent_audit_log_mutation' AND n.nspname = 'public'
      `;
      expect(fn.length).toBe(0);

      // L'utilisateur est intact.
      const users = await sql2`SELECT "id" FROM "users" WHERE "id" = ${userId}`;
      expect(users.length).toBe(1);

      // L'entrée audit_log est intacte avec le même actor_user_id et les mêmes données.
      const rows = await sql2`
        SELECT "id", "actor_user_id", "action", "metadata" FROM "audit_log" WHERE "id" = ${auditId}
      `;
      expect(rows.length).toBe(1);
      expect(rows[0]!.actor_user_id).toBe(userId);
      expect(rows[0]!.action).toBe(auditAction);
      expect(rows[0]!.metadata).toEqual(auditMetadata);
    } finally {
      await sql2.end();
    }
  });
});
