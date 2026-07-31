/**
 * @uttily/core — Test d'intégration PostgreSQL direct de withInvariantHandling
 * (P1-1, ADR-010 §D).
 *
 * Le test 43 (handle-webhook.integration.test.ts) corrompt allocation.draft_line_id,
 * mais cette incohérence est détectée pendant la validation pré-écriture
 * (confirm-booking.ts), AVANT l'insertion du booking. Il ne prouve donc pas que
 * le ROLLBACK TO SAVEPOINT annule les écritures post-écriture.
 *
 * Ce test DIRECT de `withInvariantHandling` :
 * 1. Ouvre une transaction extérieure.
 * 2. Crée une table temporaire témoin.
 * 3. Ingère un événement webhook (RECEIVED).
 * 4. Appelle `withInvariantHandling` avec un callback qui :
 *    a. Insère une ligne témoin dans la table temporaire.
 *    b. Lève un `WebhookHandlerError` irréconciliable (statusCode 500).
 * 5. Vérifie que la ligne témoin est annulée (ROLLBACK TO SAVEPOINT).
 * 6. Vérifie que l'événement webhook est marqué FAILED avec failure_code.
 * 7. Vérifie que `withInvariantHandling` retourne le `WebhookHandlerError`.
 * 8. Commit la transaction extérieure et vérifie que FAILED est persisté.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { eq, sql } from 'drizzle-orm';
import { createDatabase, paymentWebhookEvents, type DatabaseClient } from '@uttily/database';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from '../integration/setup';
import { withInvariantHandling } from './with-invariant-handling';
import { WebhookHandlerError } from './errors';
import { ingestEvent } from './dedupe-event';
import type { VerifiedWebhookEvent } from '../payments/types';

const isCi = process.env.CI === '1' || process.env.CI === 'true';

let ctx: IntegrationTestContext | null = null;
let db: DatabaseClient | null = null;
let rawSql: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  ctx = await setupIntegrationTestDb('wih_rollback');
  if (ctx) {
    db = createDatabase(ctx.databaseUrl);
    rawSql = postgres(ctx.databaseUrl, { max: 5 });
  } else if (isCi) {
    throw new Error("CI: setupIntegrationTestDb a retourné null sans lever d'erreur.");
  }
});

afterAll(async () => {
  if (db) {
    await db.$client.end();
    db = null;
  }
  if (rawSql) {
    await rawSql.end();
    rawSql = null;
  }
  if (ctx) await ctx.cleanup();
});

/** Construit un VerifiedWebhookEvent minimal pour l'ingestion. */
function makeMinimalEvent(eventId: string): VerifiedWebhookEvent {
  return {
    id: eventId,
    type: 'payment_intent.succeeded',
    created: Math.floor(Date.now() / 1000),
    apiVersion: '2026-06-24.dahlia',
    objectId: 'pi_test_witness_rollback',
    accountId: null,
    data: { id: 'pi_test_witness_rollback', object: 'payment_intent', status: 'succeeded' },
  };
}

describe.skipIf(shouldSkipIntegrationTests())(
  'withInvariantHandling — intégration PostgreSQL (rollback savepoint)',
  () => {
    it('rollback les écritures métier du savepoint et persiste FAILED dans la transaction extérieure', async () => {
      if (!db || !rawSql) return;

      const eventId = `evt_witness_rollback_${Math.random().toString(36).slice(2, 12)}`;
      const event = makeMinimalEvent(eventId);
      const rawBody = JSON.stringify({ id: eventId, type: event.type });

      // 1. Ouvrir une transaction extérieure.
      const result = await db.transaction(async (tx) => {
        // 2. Créer une table temporaire témoin dans la transaction extérieure.
        await tx.execute(sql`CREATE TEMP TABLE test_witness (id text PRIMARY KEY, val text)`);

        // 3. Ingérer un événement webhook (RECEIVED) dans la transaction extérieure.
        const ingest = await ingestEvent(tx, event, rawBody, 'TEST', null);
        const webhookEventId = ingest.row.id;
        expect(ingest.row.status).toBe('RECEIVED');

        // 4. Appeler withInvariantHandling avec un callback qui :
        //    a. Insère une ligne témoin dans la table temporaire (écriture métier).
        //    b. Lève un WebhookHandlerError irréconciliable (statusCode 500).
        const handlerResult = await withInvariantHandling(tx, webhookEventId, async (sp) => {
          // a. Insérer une ligne témoin — cette écriture doit être annulée par
          //    le ROLLBACK TO SAVEPOINT.
          await sp.execute(sql`INSERT INTO test_witness VALUES ('witness', 'before-error')`);

          // b. Lever un WebhookHandlerError irréconciliable.
          throw new WebhookHandlerError('WEBHOOK_INVARIANT_BROKEN', 'Invariant brisé témoin', {
            statusCode: 500,
          });
        });

        // 5. Vérifier que withInvariantHandling retourne le WebhookHandlerError
        //    (pas de re-throw — l'erreur est capturée et l'événement est marqué FAILED).
        expect(handlerResult).toBeInstanceOf(WebhookHandlerError);
        const returnedError = handlerResult as WebhookHandlerError;
        expect(returnedError.code).toBe('WEBHOOK_INVARIANT_BROKEN');
        expect(returnedError.statusCode).toBe(500);

        // 6. Vérifier que la ligne témoin est annulée (ROLLBACK TO SAVEPOINT).
        //    La table temporaire existe toujours (créée avant le savepoint), mais
        //    l'insertion dans le savepoint a été annulée.
        const witnessRows = await tx.execute(sql`SELECT id, val FROM test_witness`);
        expect((witnessRows as unknown[]).length).toBe(0);

        // 7. Vérifier que l'événement webhook est marqué FAILED avec failure_code.
        const failedEvent = await tx
          .select({
            status: paymentWebhookEvents.status,
            failureCode: paymentWebhookEvents.failureCode,
          })
          .from(paymentWebhookEvents)
          .where(eq(paymentWebhookEvents.id, webhookEventId))
          .limit(1);
        expect(failedEvent.length).toBe(1);
        expect(failedEvent[0]!.status).toBe('FAILED');
        expect(failedEvent[0]!.failureCode).toBe('WEBHOOK_INVARIANT_BROKEN');

        return { webhookEventId };
      });

      // 8. Après commit de la transaction extérieure, vérifier que FAILED est
      //    bien persisté (la transaction a commit avec le statut FAILED).
      const persistedEvent =
        await rawSql`SELECT status, failure_code FROM payment_webhook_events WHERE id = ${result.webhookEventId}`;
      expect(persistedEvent.length).toBe(1);
      expect(persistedEvent[0]!.status).toBe('FAILED');
      expect(persistedEvent[0]!.failure_code).toBe('WEBHOOK_INVARIANT_BROKEN');
    });
  },
);
