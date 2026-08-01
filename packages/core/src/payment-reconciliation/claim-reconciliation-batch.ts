/**
 * @uttily/core — Revendication d'un batch de réconciliation (Phase 7A, ADR-010 §12).
 *
 * Transaction PostgreSQL courte qui sélectionne les tentatives non-terminales
 * dont l'échéance de réconciliation est atteinte, les verrouille avec
 * FOR UPDATE SKIP LOCKED, et pose un lease de 2 minutes avec un token UUID.
 *
 * Aucun appel Stripe n'est effectué dans cette transaction — le COMMIT a lieu
 * avant tout appel provider.
 */

import { sql } from 'drizzle-orm';
import { type DatabaseClient } from '@uttily/database';
import type { StripeEnvironment } from '../payments/types';
import { LEASE_INTERVAL } from './scheduling';
import type { ClaimedAttempt } from './types';

/**
 * Revendique un batch de tentatives à réconcilier.
 *
 * Sélectionne les payment_attempts avec:
 * - status IN ('PENDING_PROVIDER', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING')
 * - reconcile_after <= now()
 * - (reconcile_lease_until IS NULL OR reconcile_lease_until <= now())
 * - payments.environment = environment (P1-3)
 *
 * Verrouille avec FOR UPDATE OF pa SKIP LOCKED, ORDER BY reconcile_after ASC,
 * LIMIT batchLimit. Pose reconcile_lease_until = now() + 2 minutes et
 * reconcile_lease_token = UUID aléatoire (P1-4).
 *
 * @param db Client base de données.
 * @param batchLimit Nombre maximum de tentatives à revendiquer.
 * @param environment Environnement Stripe (TEST/LIVE) pour filtrer (P1-3).
 * @returns Les tentatives revendiquées avec leur snapshot complet.
 */
export async function claimReconciliationBatch(
  db: DatabaseClient,
  batchLimit: number = 10,
  environment: StripeEnvironment = 'TEST',
): Promise<ClaimedAttempt[]> {
  return await db.transaction(async (tx) => {
    // Sélectionner et verrouiller les tentatives éligibles.
    const rows = await tx.execute(sql`
      SELECT
        pa.id AS attempt_id,
        pa.payment_id,
        pa.organization_id,
        pa.attempt_number,
        pa.status AS attempt_status,
        pa.provider_payment_intent_id,
        pa.provider_idempotency_key,
        pa.reconcile_lease_until AS current_lease_until,
        pa.created_at AS attempt_created_at,
        p.draft_id,
        p.amount_minor,
        p.currency,
        p.connected_account_id,
        p.commission_amount_minor,
        p.on_behalf_of_account_id,
        p.processing_deadline_at,
        p.environment,
        transaction_timestamp() - pa.created_at > interval '23 hours' AS is_key_expired
      FROM "payment_attempts" pa
      JOIN "payments" p ON p.id = pa.payment_id
      WHERE pa.status IN ('PENDING_PROVIDER', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING')
        AND pa.reconcile_after <= now()
        AND (pa.reconcile_lease_until IS NULL OR pa.reconcile_lease_until <= now())
        AND p.environment = ${environment}
      ORDER BY pa.reconcile_after ASC
      LIMIT ${batchLimit}
      FOR UPDATE OF pa SKIP LOCKED
    `);

    const rawRows = rows as unknown as Array<{
      attempt_id: string;
      payment_id: string;
      organization_id: string;
      attempt_number: number;
      attempt_status: string;
      provider_payment_intent_id: string | null;
      provider_idempotency_key: string;
      current_lease_until: Date | null;
      attempt_created_at: Date;
      draft_id: string;
      amount_minor: number;
      currency: string;
      connected_account_id: string;
      commission_amount_minor: number;
      on_behalf_of_account_id: string | null;
      processing_deadline_at: Date;
      environment: string;
      is_key_expired: boolean;
    }>;

    if (rawRows.length === 0) {
      return [];
    }

    // Générer un token UUID par tentative et poser le lease.
    // NOTE : le token est généré côté application (Node.js crypto.randomUUID).
    // C'est fonctionnellement sûr car le fencing token est utilisé dans un
    // UPDATE conditionnel (WHERE reconcile_lease_token = ${token}) lors du
    // release/reschedule, ce qui garantit qu'un worker ne peut effacer que
    // son propre lease. L'avantage de la génération côté application est de
    // retourner le token directement au worker sans étape de RETURNING
    // supplémentaire. Les UUID v4 de Node.js crypto sont équivalents à
    // gen_random_uuid() de PostgreSQL (RFC 4122 v4).
    const attemptIds = rawRows.map((r) => r.attempt_id);
    const leaseTokens = rawRows.map(() => crypto.randomUUID());

    // UPDATE avec FROM (VALUES) pour assigner un token différent par ligne.
    const valuesClause = leaseTokens
      .map((token, i) => `('${attemptIds[i]}'::uuid, '${token}'::uuid)`)
      .join(', ');
    const leaseRows = await tx.execute(sql`
      UPDATE "payment_attempts"
      SET "reconcile_lease_until" = now() + ${LEASE_INTERVAL},
          "reconcile_lease_token" = v.token,
          "updated_at" = transaction_timestamp()
      FROM (VALUES ${sql.raw(valuesClause)}) AS v(id, token)
      WHERE "payment_attempts"."id" = v.id
      RETURNING "payment_attempts"."id" AS id, "payment_attempts"."reconcile_lease_until" AS reconcile_lease_until
    `);

    // Construire le mapping lease par attempt.
    const leaseMap = new Map<string, Date>();
    for (const lr of leaseRows as unknown as Array<{
      id: string;
      reconcile_lease_until: Date;
    }>) {
      leaseMap.set(lr.id, lr.reconcile_lease_until);
    }

    // Construire le mapping token par attempt (même ordre que attemptIds).
    const tokenMap = new Map<string, string>();
    for (let i = 0; i < attemptIds.length; i++) {
      tokenMap.set(attemptIds[i]!, leaseTokens[i]!);
    }

    // Construire les ClaimedAttempt avec le snapshot complet.
    // Note: tx.execute() retourne les valeurs brutes de PostgreSQL ; les
    // colonnes integer arrivent en string, il faut les convertir en number.
    const claimed: ClaimedAttempt[] = [];
    for (const r of rawRows) {
      const leaseUntil = leaseMap.get(r.attempt_id);
      if (!leaseUntil) continue;
      const leaseToken = tokenMap.get(r.attempt_id);
      if (!leaseToken) continue;
      claimed.push({
        attemptId: r.attempt_id,
        paymentId: r.payment_id,
        draftId: r.draft_id,
        organizationId: r.organization_id,
        attemptNumber: Number(r.attempt_number),
        attemptStatus: r.attempt_status,
        providerPaymentIntentId: r.provider_payment_intent_id,
        providerIdempotencyKey: r.provider_idempotency_key,
        amountMinor: Number(r.amount_minor),
        currency: r.currency,
        connectedAccountId: r.connected_account_id,
        commissionAmountMinor: Number(r.commission_amount_minor),
        onBehalfOfAccountId: r.on_behalf_of_account_id,
        processingDeadlineAt: new Date(r.processing_deadline_at),
        leaseUntil,
        environment: r.environment as StripeEnvironment,
        leaseToken,
        createdAt: new Date(r.attempt_created_at),
        isKeyExpired: r.is_key_expired,
      });
    }

    return claimed;
  });
}
