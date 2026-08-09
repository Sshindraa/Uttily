import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import {
  runMigrations,
  assertLocalhost,
  type DatabaseClient,
  type DatabaseTransaction,
} from '@uttily/database';
import { idempotencyRecords } from '@uttily/database';
import * as schema from '@uttily/database';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  reserveKey,
  lockKey,
  completeKey,
  failKey,
  computeFingerprint,
  IdempotencyError,
} from './index';
import type { IdempotentPayload, IdempotencyRecordRow } from './types';

/**
 * Tests d'intégration PostgreSQL du module Idempotency (ADR-009 section 11b).
 *
 * Vérifie le protocole d'exécution : réservation PENDING, terminaison COMPLETED/FAILED,
 * conflits d'empreinte, récupération de PENDING expiré, contrainte unique.
 *
 * Reprend la stratégie de setup de schema-lot4.test.ts : base de test dédiée,
 * skip si pas DATABASE_URL en local.
 */

const TEST_DB_NAME = 'uttily_test_idempotency';
const url = process.env.DATABASE_URL;
const ci = process.env.CI === '1' || process.env.CI === 'true';

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
let db: DatabaseClient | null = null;
let seedSql: postgres.Sql | null = null;

interface SeedIds {
  orgId: string;
  locationId: string;
  userId: string;
  variantId: string;
}

async function seedBaseData(sql: postgres.Sql): Promise<SeedIds> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const org = await sql`
    INSERT INTO "organizations" ("legal_name", "slug")
    VALUES (${'Test Org ' + suffix}, ${'org-' + suffix})
    RETURNING "id"
  `.then((r) => r[0]!);
  const location = await sql`
    INSERT INTO "locations" ("organization_id", "name", "slug", "time_zone", "operating_currency")
    VALUES (${org.id}, 'Annecy', ${'annecy-' + suffix}, 'Europe/Paris', 'EUR')
    RETURNING "id"
  `.then((r) => r[0]!);
  const user = await sql`
    INSERT INTO "users" ("email")
    VALUES (${'customer-' + suffix + '@example.com'})
    RETURNING "id"
  `.then((r) => r[0]!);
  const category = await sql`SELECT "id" FROM "categories" WHERE "slug" = 'equipment' LIMIT 1`.then(
    (r) => r[0]!,
  );
  const product = await sql`
    INSERT INTO "products" ("organization_id", "category_id", "name", "slug")
    VALUES (${org.id}, ${category.id}, 'Kayak', ${'kayak-' + suffix})
    RETURNING "id"
  `.then((r) => r[0]!);
  const variant = await sql`
    INSERT INTO "product_variants" ("product_id", "name")
    VALUES (${product.id}, 'Standard')
    RETURNING "id"
  `.then((r) => r[0]!);
  return {
    orgId: org.id,
    locationId: location.id,
    userId: user.id,
    variantId: variant.id,
  };
}

function validPayload(ids: SeedIds): IdempotentPayload {
  return {
    organizationId: ids.orgId,
    locationId: ids.locationId,
    customerUserId: ids.userId,
    customerStartAt: new Date('2026-08-01T10:00:00Z'),
    customerEndAt: new Date('2026-08-03T18:00:00Z'),
    lines: [{ variantId: ids.variantId, quantity: 2 }],
  };
}

/**
 * Insère un effet métier témoin dans la table temporaire de test, à l'intérieur
 * de la transaction de création. Prouve qu'un effet transactionnel n'est créé
 * qu'une seule fois (P1-2).
 */
async function insertAuditEffect(
  tx: DatabaseTransaction,
  effectId: string,
  recordId: string,
): Promise<void> {
  await tx.execute(
    sql`INSERT INTO test_idempotency_effects (id, idempotency_record_id) VALUES (${effectId}, ${recordId})`,
  );
}

/** Empreinte hex64 valide arbitraire (64 'a'). */
const FP_A = 'a'.repeat(64);
/** Autre empreinte hex64 valide (64 'b'). */
const FP_B = 'b'.repeat(64);

beforeAll(async () => {
  if (!url) {
    if (ci) throw new Error('CI: DATABASE_URL est requise pour le test idempotency.');
    return;
  }
  if (process.env.SKIP_INTEGRATION_TESTS === '1') {
    if (ci) throw new Error('CI: SKIP_INTEGRATION_TESTS=1 est interdit en CI.');
    return;
  }
  const reachable = await checkConnectivity(url);
  if (!reachable) {
    throw new Error(
      'DATABASE_URL est définie mais la base PostgreSQL est injoignable. ' +
        'Démarrez la base (docker compose up -d postgres) ou unset DATABASE_URL pour skipper.',
    );
  }
  assertLocalhost(url);

  const adminSql = postgres(url, { max: 1 });
  try {
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
    await adminSql.unsafe(`CREATE DATABASE ${TEST_DB_NAME};`);
  } finally {
    await adminSql.end();
  }

  const testUrlObj = new URL(url);
  testUrlObj.pathname = `/${TEST_DB_NAME}`;
  testUrl = testUrlObj.toString();
  await runMigrations(testUrl);

  seedSql = postgres(testUrl, { max: 1 });
  db = drizzle(postgres(testUrl, { max: 5 }));
});

afterAll(async () => {
  if (seedSql) {
    await seedSql.end();
    seedSql = null;
  }
  if (db) {
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
    db = null;
  }
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

describe.skipIf(shouldSkipIntegrationTests())('Idempotency integration — protocole ADR-009', () => {
  // -------------------------------------------------------------------------
  // 1. reserveKey ACQUIRED
  // -------------------------------------------------------------------------
  it('reserveKey : première réservation → ACQUIRED, PENDING, pendingTimeoutAt non null', async () => {
    if (!db || !seedSql) return;
    const ids = await seedBaseData(seedSql);
    const res = await reserveKey(db, {
      organizationId: ids.orgId,
      operation: 'create_draft',
      key: 'key-1',
      requestFingerprint: FP_A,
    });
    expect(res.kind).toBe('ACQUIRED');
    if (res.kind !== 'ACQUIRED') return;
    expect(res.record.status).toBe('PENDING');
    expect(res.record.pendingTimeoutAt).not.toBeNull();
    expect(res.record.requestFingerprint).toBe(FP_A);
    expect(res.record.resourceId).toBeNull();
    expect(res.record.responseStatusCode).toBeNull();
    expect(res.record.responseBody).toBeNull();
    expect(res.record.completedAt).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 2. reserveKey REPLAY (après completeKey)
  // -------------------------------------------------------------------------
  it('reserveKey : après completeKey, seconde réservation même clé+empreinte → REPLAY', async () => {
    if (!db || !seedSql) return;
    const ids = await seedBaseData(seedSql);
    const res1 = await reserveKey(db, {
      organizationId: ids.orgId,
      operation: 'create_draft',
      key: 'key-2',
      requestFingerprint: FP_A,
    });
    expect(res1.kind).toBe('ACQUIRED');
    if (res1.kind !== 'ACQUIRED') return;

    const resourceId = randomUUID();
    await db.transaction(async (tx) => {
      await lockKey(tx, res1.record.id);
      await completeKey(tx, res1.record.id, {
        resourceId,
        responseStatusCode: 201,
        responseBody: { ok: true, draftId: resourceId },
      });
    });

    const res2 = await reserveKey(db, {
      organizationId: ids.orgId,
      operation: 'create_draft',
      key: 'key-2',
      requestFingerprint: FP_A,
    });
    expect(res2.kind).toBe('REPLAY');
    if (res2.kind !== 'REPLAY') return;
    expect(res2.record.status).toBe('COMPLETED');
    expect(res2.record.resourceId).toBe(resourceId);
    expect(res2.record.responseStatusCode).toBe(201);
    expect(res2.record.responseBody).toEqual({ ok: true, draftId: resourceId });
  });

  // -------------------------------------------------------------------------
  // 3. reserveKey CONFLICT (empreinte différente)
  // -------------------------------------------------------------------------
  it('reserveKey : même clé, empreinte différente → CONFLICT', async () => {
    if (!db || !seedSql) return;
    const ids = await seedBaseData(seedSql);
    await reserveKey(db, {
      organizationId: ids.orgId,
      operation: 'create_draft',
      key: 'key-3',
      requestFingerprint: FP_A,
    });
    const res = await reserveKey(db, {
      organizationId: ids.orgId,
      operation: 'create_draft',
      key: 'key-3',
      requestFingerprint: FP_B,
    });
    expect(res.kind).toBe('CONFLICT');
    if (res.kind !== 'CONFLICT') return;
    expect(res.record.requestFingerprint).toBe(FP_A);
  });

  // -------------------------------------------------------------------------
  // 4. reserveKey REPLAY (après FAILED)
  // -------------------------------------------------------------------------
  it('reserveKey : après failKey, seconde réservation même clé+empreinte → REPLAY (réponse erreur)', async () => {
    if (!db || !seedSql) return;
    const ids = await seedBaseData(seedSql);
    const res1 = await reserveKey(db, {
      organizationId: ids.orgId,
      operation: 'create_draft',
      key: 'key-4',
      requestFingerprint: FP_A,
    });
    expect(res1.kind).toBe('ACQUIRED');
    if (res1.kind !== 'ACQUIRED') return;

    await db.transaction(async (tx) => {
      await lockKey(tx, res1.record.id);
      await failKey(tx, res1.record.id, {
        responseStatusCode: 422,
        responseBody: { error: 'insufficient_inventory' },
      });
    });

    const res2 = await reserveKey(db, {
      organizationId: ids.orgId,
      operation: 'create_draft',
      key: 'key-4',
      requestFingerprint: FP_A,
    });
    expect(res2.kind).toBe('REPLAY');
    if (res2.kind !== 'REPLAY') return;
    expect(res2.record.status).toBe('FAILED');
    expect(res2.record.responseStatusCode).toBe(422);
    expect(res2.record.responseBody).toEqual({ error: 'insufficient_inventory' });
    expect(res2.record.resourceId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 5. completeKey
  // -------------------------------------------------------------------------
  it('completeKey : transition PENDING → COMPLETED avec resource_id, status_code, body, completed_at', async () => {
    if (!db || !seedSql) return;
    const ids = await seedBaseData(seedSql);
    const res = await reserveKey(db, {
      organizationId: ids.orgId,
      operation: 'create_draft',
      key: 'key-5',
      requestFingerprint: FP_A,
    });
    expect(res.kind).toBe('ACQUIRED');
    if (res.kind !== 'ACQUIRED') return;

    const resourceId = randomUUID();
    const completed = await db.transaction(async (tx) => {
      await lockKey(tx, res.record.id);
      return await completeKey(tx, res.record.id, {
        resourceId,
        responseStatusCode: 201,
        responseBody: { ok: true },
      });
    });
    expect(completed.status).toBe('COMPLETED');
    expect(completed.resourceId).toBe(resourceId);
    expect(completed.responseStatusCode).toBe(201);
    expect(completed.responseBody).toEqual({ ok: true });
    expect(completed.completedAt).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 6. failKey
  // -------------------------------------------------------------------------
  it('failKey : transition PENDING → FAILED, resource_id reste null', async () => {
    if (!db || !seedSql) return;
    const ids = await seedBaseData(seedSql);
    const res = await reserveKey(db, {
      organizationId: ids.orgId,
      operation: 'create_draft',
      key: 'key-6',
      requestFingerprint: FP_A,
    });
    expect(res.kind).toBe('ACQUIRED');
    if (res.kind !== 'ACQUIRED') return;

    const failed = await db.transaction(async (tx) => {
      await lockKey(tx, res.record.id);
      return await failKey(tx, res.record.id, {
        responseStatusCode: 422,
        responseBody: { error: 'invalid' },
      });
    });
    expect(failed.status).toBe('FAILED');
    expect(failed.responseStatusCode).toBe(422);
    expect(failed.responseBody).toEqual({ error: 'invalid' });
    expect(failed.completedAt).not.toBeNull();
    expect(failed.resourceId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 7. completeKey sur non-PENDING
  // -------------------------------------------------------------------------
  it('completeKey sur un enregistrement déjà COMPLETED → erreur', async () => {
    if (!db || !seedSql) return;
    const ids = await seedBaseData(seedSql);
    const res = await reserveKey(db, {
      organizationId: ids.orgId,
      operation: 'create_draft',
      key: 'key-7',
      requestFingerprint: FP_A,
    });
    expect(res.kind).toBe('ACQUIRED');
    if (res.kind !== 'ACQUIRED') return;

    const resourceId = randomUUID();
    await db.transaction(async (tx) => {
      await lockKey(tx, res.record.id);
      await completeKey(tx, res.record.id, {
        resourceId,
        responseStatusCode: 201,
        responseBody: { ok: true },
      });
    });

    await expect(
      db.transaction(async (tx) => {
        await completeKey(tx, res.record.id, {
          resourceId: randomUUID(),
          responseStatusCode: 201,
          responseBody: { ok: true },
        });
      }),
    ).rejects.toThrow(IdempotencyError);
  });

  // -------------------------------------------------------------------------
  // 8. failKey sur non-PENDING
  // -------------------------------------------------------------------------
  it('failKey sur un enregistrement déjà FAILED → erreur', async () => {
    if (!db || !seedSql) return;
    const ids = await seedBaseData(seedSql);
    const res = await reserveKey(db, {
      organizationId: ids.orgId,
      operation: 'create_draft',
      key: 'key-8',
      requestFingerprint: FP_A,
    });
    expect(res.kind).toBe('ACQUIRED');
    if (res.kind !== 'ACQUIRED') return;

    await db.transaction(async (tx) => {
      await lockKey(tx, res.record.id);
      await failKey(tx, res.record.id, {
        responseStatusCode: 422,
        responseBody: { error: 'invalid' },
      });
    });

    await expect(
      db.transaction(async (tx) => {
        await failKey(tx, res.record.id, {
          responseStatusCode: 500,
          responseBody: { error: 'again' },
        });
      }),
    ).rejects.toThrow(IdempotencyError);
  });

  // -------------------------------------------------------------------------
  // 9. Récupération PENDING expiré
  // -------------------------------------------------------------------------
  it('récupération PENDING expiré : reserveKey avec même empreinte → ACQUIRED (renouvelé)', async () => {
    if (!db || !seedSql) return;
    const ids = await seedBaseData(seedSql);
    // Crée un PENDING expiré directement en base.
    const expired = await seedSql`
      INSERT INTO "idempotency_records" (
        "organization_id", "operation", "key", "request_fingerprint", "status", "pending_timeout_at"
      )
      VALUES (
        ${ids.orgId}, 'create_draft', 'key-9', ${FP_A}, 'PENDING', ${new Date(Date.now() - 60_000)}
      )
      RETURNING "id"
    `.then((r) => r[0]!);

    const res = await reserveKey(db, {
      organizationId: ids.orgId,
      operation: 'create_draft',
      key: 'key-9',
      requestFingerprint: FP_A,
    });
    expect(res.kind).toBe('ACQUIRED');
    if (res.kind !== 'ACQUIRED') return;
    expect(res.record.id).toBe(expired.id);
    expect(res.record.status).toBe('PENDING');
    expect(res.record.pendingTimeoutAt).not.toBeNull();
    expect(res.record.pendingTimeoutAt!.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  // -------------------------------------------------------------------------
  // 10. PENDING non expiré
  // -------------------------------------------------------------------------
  it('PENDING non expiré avec même empreinte → PENDING (opération en cours)', async () => {
    if (!db || !seedSql) return;
    const ids = await seedBaseData(seedSql);
    // Crée un PENDING actif (timeout dans le futur) directement en base.
    await seedSql`
      INSERT INTO "idempotency_records" (
        "organization_id", "operation", "key", "request_fingerprint", "status", "pending_timeout_at"
      )
      VALUES (
        ${ids.orgId}, 'create_draft', 'key-10', ${FP_A}, 'PENDING', ${new Date(Date.now() + 60_000)}
      )
    `;

    const res = await reserveKey(db, {
      organizationId: ids.orgId,
      operation: 'create_draft',
      key: 'key-10',
      requestFingerprint: FP_A,
    });
    expect(res.kind).toBe('PENDING');
    if (res.kind !== 'PENDING') return;
    expect(res.record.status).toBe('PENDING');
  });

  // -------------------------------------------------------------------------
  // 11. Contrainte unique
  // -------------------------------------------------------------------------
  it('contrainte unique : deux insertions même (org, operation, key) → ON CONFLICT DO NOTHING retourne 0 ligne', async () => {
    if (!db || !seedSql) return;
    const ids = await seedBaseData(seedSql);
    const first = await db
      .insert(idempotencyRecords)
      .values({
        organizationId: ids.orgId,
        operation: 'create_draft',
        key: 'key-11',
        requestFingerprint: FP_A,
        status: 'PENDING',
        pendingTimeoutAt: new Date(Date.now() + 60_000),
      })
      .onConflictDoNothing({
        target: [
          idempotencyRecords.organizationId,
          idempotencyRecords.operation,
          idempotencyRecords.key,
        ],
      })
      .returning();
    expect(first).toHaveLength(1);

    const second = await db
      .insert(idempotencyRecords)
      .values({
        organizationId: ids.orgId,
        operation: 'create_draft',
        key: 'key-11',
        requestFingerprint: FP_B,
        status: 'PENDING',
        pendingTimeoutAt: new Date(Date.now() + 60_000),
      })
      .onConflictDoNothing({
        target: [
          idempotencyRecords.organizationId,
          idempotencyRecords.operation,
          idempotencyRecords.key,
        ],
      })
      .returning();
    expect(second).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 12. Empreinte intégration
  // -------------------------------------------------------------------------
  it('computeFingerprint + reserveKey avec empreinte calculée → ACQUIRED', async () => {
    if (!db || !seedSql) return;
    const ids = await seedBaseData(seedSql);
    const payload = validPayload(ids);
    const fingerprint = computeFingerprint(payload);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const res = await reserveKey(db, {
      organizationId: ids.orgId,
      operation: 'create_draft',
      key: 'key-12',
      requestFingerprint: fingerprint,
    });
    expect(res.kind).toBe('ACQUIRED');
    if (res.kind !== 'ACQUIRED') return;
    expect(res.record.requestFingerprint).toBe(fingerprint);
    expect(res.record.status).toBe('PENDING');

    // Vérifie la persistance en relisant via Drizzle.
    const persisted = await db
      .select()
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.id, res.record.id))
      .limit(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.requestFingerprint).toBe(fingerprint);
  });

  // -------------------------------------------------------------------------
  // 13. Concurrence : deux reserveKey mêmes clé+empreinte → un seul ACQUIRED
  // -------------------------------------------------------------------------
  it('deux reserveKey concurrents avec la même clé + même empreinte → un seul ACQUIRED', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 10 });
    const db = drizzle(sql, { schema });
    try {
      const ids = await seedBaseData(sql);
      const fingerprint = computeFingerprint(validPayload(ids));
      const input = {
        organizationId: ids.orgId,
        operation: 'create_booking_draft',
        key: 'concurrent-same-key',
        requestFingerprint: fingerprint,
      };
      // Lance deux reserveKey en parallèle.
      const [r1, r2] = await Promise.all([reserveKey(db, input), reserveKey(db, input)]);
      // Un seul doit être ACQUIRED, l'autre doit être PENDING ou REPLAY.
      const acquired = [r1, r2].filter((r) => r.kind === 'ACQUIRED');
      const others = [r1, r2].filter((r) => r.kind !== 'ACQUIRED');
      expect(acquired.length).toBe(1);
      expect(others.length).toBe(1);
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 14. Concurrence : deux reserveKey mêmes clé, empreintes différentes
  // -------------------------------------------------------------------------
  it('deux reserveKey concurrents avec la même clé + empreintes différentes → un ACQUIRED, un CONFLICT', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 10 });
    const db = drizzle(sql, { schema });
    try {
      const ids = await seedBaseData(sql);
      const fp1 = computeFingerprint(validPayload(ids));
      const fp2 = computeFingerprint({
        ...validPayload(ids),
        lines: [{ variantId: ids.variantId, quantity: 5 }],
      });
      // Lance deux reserveKey en parallèle avec des empreintes différentes.
      const [r1, r2] = await Promise.all([
        reserveKey(db, {
          organizationId: ids.orgId,
          operation: 'create_booking_draft',
          key: 'concurrent-diff-fp',
          requestFingerprint: fp1,
        }),
        reserveKey(db, {
          organizationId: ids.orgId,
          operation: 'create_booking_draft',
          key: 'concurrent-diff-fp',
          requestFingerprint: fp2,
        }),
      ]);
      // Un seul ACQUIRED, l'autre CONFLICT.
      const acquired = [r1, r2].filter((r) => r.kind === 'ACQUIRED');
      const conflicts = [r1, r2].filter((r) => r.kind === 'CONFLICT');
      expect(acquired.length).toBe(1);
      expect(conflicts.length).toBe(1);
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 15. Race condition : enregistrement supprimé entre ON CONFLICT et SELECT
  // -------------------------------------------------------------------------
  it('race condition : enregistrement supprimé entre ON CONFLICT et SELECT → IdempotencyError', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    const db = drizzle(sql, { schema });
    try {
      const ids = await seedBaseData(sql);
      // Insère un enregistrement PENDING directement.
      const fp = computeFingerprint(validPayload(ids));
      await db
        .insert(idempotencyRecords)
        .values({
          organizationId: ids.orgId,
          operation: 'create_booking_draft',
          key: 'race-delete-key',
          requestFingerprint: fp,
          status: 'PENDING',
          pendingTimeoutAt: new Date(Date.now() + 5 * 60 * 1000),
        })
        .returning();
      // Crée un trigger BEFORE INSERT qui supprime l'enregistrement existant
      // et retourne NULL (annule l'insertion). Cela simule déterministiquement
      // la race condition : l'INSERT retourne 0 lignes (annulé par le trigger),
      // puis le SELECT retourne 0 lignes (l'enregistrement a été supprimé par
      // le trigger) → IdempotencyError.
      await sql.unsafe(`
        CREATE OR REPLACE FUNCTION _race_delete_existing() RETURNS trigger AS $$
        BEGIN
          DELETE FROM idempotency_records
          WHERE organization_id = NEW.organization_id
            AND operation = NEW.operation
            AND key = NEW.key;
          RETURN NULL;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await sql.unsafe(`
        CREATE TRIGGER _race_delete_trigger
        BEFORE INSERT ON idempotency_records
        FOR EACH ROW
        WHEN (NEW.key = 'race-delete-key')
        EXECUTE FUNCTION _race_delete_existing();
      `);
      try {
        // reserveKey : l'INSERT déclenche le trigger qui supprime l'enregistrement
        // existant et annule l'insertion (retourne 0). Le SELECT suivant ne trouve
        // plus l'enregistrement → IdempotencyError.
        await expect(
          reserveKey(db, {
            organizationId: ids.orgId,
            operation: 'create_booking_draft',
            key: 'race-delete-key',
            requestFingerprint: fp,
          }),
        ).rejects.toThrow(IdempotencyError);
      } finally {
        await sql.unsafe(`DROP TRIGGER IF EXISTS _race_delete_trigger ON idempotency_records;`);
        await sql.unsafe(`DROP FUNCTION IF EXISTS _race_delete_existing();`);
      }
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 16. lockKey verrouille une ligne PENDING et retourne l'enregistrement
  // -------------------------------------------------------------------------
  it('lockKey verrouille une ligne PENDING et retourne l’enregistrement', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    const db = drizzle(sql, { schema });
    try {
      const ids = await seedBaseData(sql);
      const fp = computeFingerprint(validPayload(ids));
      const reservation = await reserveKey(db, {
        organizationId: ids.orgId,
        operation: 'create_booking_draft',
        key: 'lock-pending-key',
        requestFingerprint: fp,
      });
      if (reservation.kind !== 'ACQUIRED') throw new Error('Expected ACQUIRED');
      // lockKey dans une transaction.
      const locked = await db.transaction(async (tx) => {
        return await lockKey(tx, reservation.record.id);
      });
      expect(locked.kind).toBe('LOCKED');
      if (locked.kind !== 'LOCKED') return;
      expect(locked.record.status).toBe('PENDING');
      expect(locked.record.id).toBe(reservation.record.id);
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 17. lockKey sur un enregistrement COMPLETED → REPLAY
  // -------------------------------------------------------------------------
  it('lockKey sur un enregistrement COMPLETED → REPLAY', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    const db = drizzle(sql, { schema });
    try {
      const ids = await seedBaseData(sql);
      const fp = computeFingerprint(validPayload(ids));
      const reservation = await reserveKey(db, {
        organizationId: ids.orgId,
        operation: 'create_booking_draft',
        key: 'lock-completed-key',
        requestFingerprint: fp,
      });
      if (reservation.kind !== 'ACQUIRED') throw new Error('Expected ACQUIRED');
      // Termine en COMPLETED.
      await db.transaction(async (tx) => {
        await lockKey(tx, reservation.record.id);
        await completeKey(tx, reservation.record.id, {
          resourceId: reservation.record.id, // faux resource_id pour le test
          responseStatusCode: 201,
          responseBody: { ok: true },
        });
      });
      // Tente lockKey sur un enregistrement COMPLETED → REPLAY.
      const result = await db.transaction(async (tx) => {
        return await lockKey(tx, reservation.record.id);
      });
      expect(result.kind).toBe('REPLAY');
      if (result.kind !== 'REPLAY') return;
      expect(result.record.status).toBe('COMPLETED');
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 18. lockKey sur un enregistrement inexistant → IdempotencyError
  // -------------------------------------------------------------------------
  it('lockKey sur un enregistrement inexistant → IdempotencyError', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 1 });
    const db = drizzle(sql, { schema });
    try {
      await expect(
        db.transaction(async (tx) => {
          await lockKey(tx, '00000000-0000-0000-0000-000000000000');
        }),
      ).rejects.toThrow(IdempotencyError);
    } finally {
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 19. Concurrence end-to-end : une seule création, deux réponses identiques
  // -------------------------------------------------------------------------
  it('concurrence end-to-end : une seule création, deux réponses identiques', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 10 });
    const db = drizzle(sql, { schema });
    try {
      const ids = await seedBaseData(sql);
      // Crée la table temporaire des effets témoin (P1-2).
      await sql`CREATE TABLE IF NOT EXISTS test_idempotency_effects (
        id uuid PRIMARY KEY,
        idempotency_record_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
      const fp = computeFingerprint(validPayload(ids));
      const input = {
        organizationId: ids.orgId,
        operation: 'create_booking_draft',
        key: 'e2e-concurrent-key',
        requestFingerprint: fp,
      };

      // Lance deux requêtes concurrentes complètes.
      // ACQUIRED et PENDING passent tous deux par une seule transaction
      // qui englobe lockKey + effet métier + completeKey (P1-1).
      const runRequest = async (): Promise<{
        kind: string;
        record: IdempotencyRecordRow | null;
      }> => {
        const reservation = await reserveKey(db, input);

        if (reservation.kind === 'REPLAY') {
          return { kind: 'REPLAY', record: reservation.record };
        }
        if (reservation.kind === 'CONFLICT') {
          return { kind: 'CONFLICT', record: reservation.record };
        }

        // ACQUIRED ou PENDING : une seule transaction pour lockKey + effet + completeKey.
        const result = await db.transaction(async (tx) => {
          const lock = await lockKey(tx, reservation.record.id);

          if (lock.kind === 'REPLAY') {
            return { kind: 'REPLAY', record: lock.record };
          }

          // LOCKED : effet métier témoin + completeKey dans la même transaction.
          const effectId = randomUUID();
          await insertAuditEffect(tx, effectId, reservation.record.id);

          const completed = await completeKey(tx, reservation.record.id, {
            resourceId: effectId,
            responseStatusCode: 201,
            responseBody: { ok: true, effectId },
          });
          return { kind: 'COMPLETED', record: completed };
        });

        return result;
      };

      const [r1, r2] = await Promise.all([runRequest(), runRequest()]);

      // Une seule création (un seul COMPLETED).
      const completedResult = [r1, r2].find((r) => r.kind === 'COMPLETED');
      const replayResult = [r1, r2].find((r) => r.kind === 'REPLAY');
      expect(completedResult).toBeDefined();
      expect(replayResult).toBeDefined();

      // Vérifier qu'une seule ligne idempotency_records existe avec status COMPLETED.
      const records = await db
        .select()
        .from(idempotencyRecords)
        .where(eq(idempotencyRecords.key, 'e2e-concurrent-key'));
      expect(records.length).toBe(1);
      expect(records[0]!.status).toBe('COMPLETED');

      // Une seule ligne d'effet témoin (P1-2) : l'effet transactionnel n'est créé qu'une fois.
      const recordId = records[0]!.id;
      const effects =
        await sql`SELECT * FROM test_idempotency_effects WHERE idempotency_record_id = ${recordId}`;
      expect(effects.length).toBe(1);

      // Les deux réponses sont strictement identiques (même statusCode, body, resourceId).
      expect(replayResult!.record!.responseStatusCode).toBe(
        completedResult!.record!.responseStatusCode,
      );
      expect(replayResult!.record!.responseBody).toEqual(completedResult!.record!.responseBody);
      expect(replayResult!.record!.resourceId).toBe(completedResult!.record!.resourceId);

      // Le resourceId correspond à l'effectId de l'effet témoin.
      expect(completedResult!.record!.resourceId).toBe(effects[0]!.id);
    } finally {
      await sql`DROP TABLE IF EXISTS test_idempotency_effects`;
      await sql.end();
    }
  });

  // -------------------------------------------------------------------------
  // 20. lockKey : le second FOR UPDATE attend le commit du premier
  // -------------------------------------------------------------------------
  it('lockKey : le second FOR UPDATE attend le commit du premier', async () => {
    if (!testUrl) return;
    const sql = postgres(testUrl, { max: 10 });
    const db = drizzle(sql, { schema });
    try {
      const ids = await seedBaseData(sql);
      const fp = computeFingerprint(validPayload(ids));
      const reservation = await reserveKey(db, {
        organizationId: ids.orgId,
        operation: 'create_booking_draft',
        key: 'lock-wait-key',
        requestFingerprint: fp,
      });
      if (reservation.kind !== 'ACQUIRED') throw new Error('Expected ACQUIRED');
      const recordId = reservation.record.id;

      // Barrières explicites : la première transaction signale qu'elle a acquis le
      // verrou, puis attend l'autorisation de committer. La seconde transaction ne
      // démarre qu'après que la première a confirmé la prise du verrou (P2-4).
      const lockAcquiredSignal = { resolve: (): void => {} };
      const lockAcquiredPromise = new Promise<void>((resolve) => {
        lockAcquiredSignal.resolve = resolve;
      });
      const commitSignal = { resolve: (): void => {} };
      const commitPromise = new Promise<void>((resolve) => {
        commitSignal.resolve = resolve;
      });

      // Première transaction : acquiert le verrou, signale, attend l'autorisation de committer.
      const firstPromise = db.transaction(async (tx) => {
        await lockKey(tx, recordId);
        lockAcquiredSignal.resolve(); // Signale que le verrou est acquis.

        await commitPromise; // Attend l'autorisation de committer.

        await completeKey(tx, recordId, {
          resourceId: recordId,
          responseStatusCode: 201,
          responseBody: { ok: true },
        });
      });

      // Attend que la première transaction ait acquis le verrou.
      await lockAcquiredPromise;

      // Démarre la seconde transaction : elle doit être bloquée sur FOR UPDATE.
      let secondCompleted = false;
      const secondPromise = db.transaction(async (tx) => {
        const result = await lockKey(tx, recordId);
        secondCompleted = true;
        expect(result.kind).toBe('REPLAY');
        if (result.kind !== 'REPLAY') return;
        expect(result.record.status).toBe('COMPLETED');
      });

      // Vérifie que la seconde transaction n'a pas terminé (elle est bloquée).
      // Attend un court délai (100ms) pour confirmer qu'elle est en attente.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(secondCompleted).toBe(false);

      // Autorise la première transaction à committer.
      commitSignal.resolve();

      // Attend que les deux transactions terminent.
      await Promise.all([firstPromise, secondPromise]);
      expect(secondCompleted).toBe(true);
    } finally {
      await sql.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests unitaires de validation des entrées de reserveKey (P2-5).
// Pas besoin de PostgreSQL : la validation échoue avant tout accès base.
// ---------------------------------------------------------------------------
describe('reserveKey — validation des entrées', () => {
  it('organizationId vide → IdempotencyError(VALIDATION)', async () => {
    await expect(
      reserveKey({} as DatabaseClient, {
        organizationId: '',
        operation: 'create_booking_draft',
        key: 'key-1',
        requestFingerprint: 'a'.repeat(64),
      }),
    ).rejects.toThrow(IdempotencyError);
  });

  it('operation vide → IdempotencyError(VALIDATION)', async () => {
    await expect(
      reserveKey({} as DatabaseClient, {
        organizationId: 'org-1',
        operation: '',
        key: 'key-1',
        requestFingerprint: 'a'.repeat(64),
      }),
    ).rejects.toThrow(IdempotencyError);
  });

  it('key vide → IdempotencyError(VALIDATION)', async () => {
    await expect(
      reserveKey({} as DatabaseClient, {
        organizationId: 'org-1',
        operation: 'create_booking_draft',
        key: '',
        requestFingerprint: 'a'.repeat(64),
      }),
    ).rejects.toThrow(IdempotencyError);
  });

  it('requestFingerprint non hex64 → IdempotencyError(VALIDATION)', async () => {
    await expect(
      reserveKey({} as DatabaseClient, {
        organizationId: 'org-1',
        operation: 'create_booking_draft',
        key: 'key-1',
        requestFingerprint: 'not-a-hash',
      }),
    ).rejects.toThrow(IdempotencyError);
  });

  it('pendingTimeoutMs = 0 → IdempotencyError(VALIDATION)', async () => {
    await expect(
      reserveKey({} as DatabaseClient, {
        organizationId: 'org-1',
        operation: 'create_booking_draft',
        key: 'key-1',
        requestFingerprint: 'a'.repeat(64),
        pendingTimeoutMs: 0,
      }),
    ).rejects.toThrow(IdempotencyError);
  });

  it('pendingTimeoutMs négatif → IdempotencyError(VALIDATION)', async () => {
    await expect(
      reserveKey({} as DatabaseClient, {
        organizationId: 'org-1',
        operation: 'create_booking_draft',
        key: 'key-1',
        requestFingerprint: 'a'.repeat(64),
        pendingTimeoutMs: -1,
      }),
    ).rejects.toThrow(IdempotencyError);
  });
});
