/**
 * @uttily/core — Déduplication idempotente des événements webhook (Lot 5, ADR-010 §7, §9, §10).
 *
 * Insertion idempotente dans `payment_webhook_events` + résolution
 * organization_id. L'ordre de verrouillage global (ADR-010 §10) exige que
 * `payment_webhook_events` soit verrouillé EN DERNIER, après tous les autres
 * verrous métier. C'est pourquoi l'ingestion (INSERT + SELECT sans FOR UPDATE)
 * est séparée du verrouillage (SELECT ... FOR UPDATE) qui doit avoir lieu en
 * dernier dans la transaction métier.
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  organizationPaymentAccounts,
  paymentWebhookEvents,
  type DatabaseClient,
  type DatabaseTransaction,
} from '@uttily/database';
import { createHash } from 'node:crypto';
import type { VerifiedWebhookEvent } from '../payments/types';
import type { WebhookEventRow } from './types';

/**
 * Calcule le SHA-256 hex (64 chars) du corps brut du webhook.
 * Ne persiste JAMAIS le corps brut — uniquement son hash.
 */
export function computePayloadSha256(rawBody: string): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/**
 * Construit le normalized_payload (allow-list stricte) depuis l'événement vérifié.
 * Aucune donnée de carte ou secret n'est incluse.
 */
function buildNormalizedPayload(event: VerifiedWebhookEvent): Record<string, unknown> {
  return {
    id: event.id,
    type: event.type,
    created: event.created,
    api_version: event.apiVersion,
    object: event.data,
  };
}

/**
 * Résout l'organization_id depuis un compte connecté (provider_account_id).
 * Utilisé pour les événements Connect (account.updated) sans tentative associée.
 */
async function resolveOrgFromConnectedAccount(
  db: DatabaseClient,
  providerAccountId: string,
  environment: 'TEST' | 'LIVE',
): Promise<string | null> {
  const rows = await db
    .select({ organizationId: organizationPaymentAccounts.organizationId })
    .from(organizationPaymentAccounts)
    .where(
      and(
        eq(organizationPaymentAccounts.providerAccountId, providerAccountId),
        eq(organizationPaymentAccounts.environment, environment),
      ),
    )
    .limit(1);
  return rows.length > 0 ? rows[0]!.organizationId : null;
}

/** Résultat de l'ingestion (sans verrou FOR UPDATE). */
export interface IngestResult {
  /** Ligne d'événement après insertion (id + status lus sans verrou). */
  row: { id: string; status: string };
  /** true si l'événement est un doublon déjà PROCESSED ou IGNORED. */
  isDuplicate: boolean;
  /** organization_id résolu (peut être null si non rattachable). */
  organizationId: string | null;
}

/** Résultat de la déduplication (compat — ingest + lock). */
export interface DedupeResult {
  /** Ligne d'événement après insertion/déduplication. */
  row: WebhookEventRow;
  /** true si l'événement est un doublon déjà PROCESSED. */
  isDuplicate: boolean;
  /** organization_id résolu (peut être null si non rattachable). */
  organizationId: string | null;
}

/** UUID nil pour les événements non rattachables (anomalie plateforme).
 * Conservé pour compatibilité ascendante mais ne plus utiliser pour l'insertion :
 * la colonne organization_id est désormais nullable (migration 0021). */
export const NIL_ORG_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Inère ou récupère un événement webhook de manière idempotente SANS verrou
 * FOR UPDATE. Cette fonction doit être appelée dans une transaction courte
 * (transaction 1 — ingestion) AVANT la transaction métier.
 *
 * Étapes (ADR-010 §7, §9, §10) :
 * 1. Calculer payload_sha256 et normalized_payload.
 * 2. `INSERT ... ON CONFLICT DO NOTHING`.
 * 3. `SELECT` (sans FOR UPDATE) pour lire le statut.
 * 4. Si la ligne existante est déjà PROCESSED/IGNORED → doublon (retourner 2xx sans rejouer).
 * 5. Si la ligne est RECEIVED → premier worker la traite (le verrou FOR UPDATE aura lieu en dernier).
 *
 * @param tx Transaction active.
 * @param event Événement webhook vérifié.
 * @param rawBody Corps brut (pour le hash uniquement).
 * @param environment Environnement Stripe.
 * @param organizationId organization_id résolu (depuis la tentative ou le compte connecté), ou null.
 */
export async function ingestEvent(
  tx: DatabaseTransaction,
  event: VerifiedWebhookEvent,
  rawBody: string,
  environment: 'TEST' | 'LIVE',
  organizationId: string | null,
): Promise<IngestResult> {
  const payloadSha256 = computePayloadSha256(rawBody);
  const normalizedPayload = buildNormalizedPayload(event);

  // organization_id est nullable (migration 0021) : on insère NULL pour les
  // événements non rattachables au lieu d'un UUID nil qui violait la FK.
  const effectiveOrgId = organizationId ?? null;

  // Insertion idempotente : ON CONFLICT DO NOTHING.
  await tx
    .insert(paymentWebhookEvents)
    .values({
      organizationId: effectiveOrgId,
      provider: 'STRIPE',
      environment,
      providerEventId: event.id,
      providerEventCreatedAt: event.created,
      eventType: event.type,
      providerObjectId: event.objectId,
      providerAccountId: event.accountId,
      apiVersion: event.apiVersion,
      payloadSha256,
      normalizedPayload,
      status: 'RECEIVED',
    })
    .onConflictDoNothing({
      target: [
        paymentWebhookEvents.provider,
        paymentWebhookEvents.environment,
        paymentWebhookEvents.providerEventId,
      ],
    });

  // SELECT sans FOR UPDATE (le verrou FOR UPDATE aura lieu en dernier dans la
  // transaction métier, après tous les autres verrous — ADR-010 §10).
  const rows = await tx
    .select({
      id: paymentWebhookEvents.id,
      status: paymentWebhookEvents.status,
    })
    .from(paymentWebhookEvents)
    .where(
      and(
        eq(paymentWebhookEvents.provider, 'STRIPE'),
        eq(paymentWebhookEvents.environment, environment),
        eq(paymentWebhookEvents.providerEventId, event.id),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    // Ne devrait pas arriver après l'insertion idempotente.
    throw new Error('Événement webhook introuvable après insertion idempotente');
  }

  const row = rows[0]!;
  // P1-2 : Un événement FAILED est aussi considéré comme dédupliqué — un retry
  // Stripe du même provider_event_id retourne 200 sans rejouer (l'invariant
  // irréconciliable a déjà été marqué FAILED).
  const isDuplicate =
    row.status === 'PROCESSED' || row.status === 'IGNORED' || row.status === 'FAILED';

  return {
    row: { id: row.id, status: row.status },
    isDuplicate,
    organizationId: effectiveOrgId,
  };
}

/**
 * Verrouille l'événement webhook FOR UPDATE. Doit être appelé EN DERNIER dans
 * la transaction métier, après tous les autres verrous (draft → blocks →
 * allocations → payment → attempt), conformément à l'ordre global ADR-010 §10.
 *
 * Re-vérifie le statut après verrouillage : un worker concurrent a pu traiter
 * l'événement entre l'ingestion et maintenant.
 *
 * @param tx Transaction active.
 * @param webhookEventId ID de la ligne payment_webhook_events.
 * @returns La ligne verrouillée { id, status }.
 */
export async function lockWebhookEvent(
  tx: DatabaseTransaction,
  webhookEventId: string,
): Promise<{ id: string; status: string }> {
  const rows = await tx
    .select({ id: paymentWebhookEvents.id, status: paymentWebhookEvents.status })
    .from(paymentWebhookEvents)
    .where(eq(paymentWebhookEvents.id, webhookEventId))
    .for('update')
    .limit(1);

  if (rows.length === 0) {
    // L'événement a été supprimé entre l'ingestion et le verrouillage.
    return { id: webhookEventId, status: 'MISSING' };
  }

  return rows[0]!;
}

/**
 * Insère ou récupère un événement webhook de manière idempotente, avec verrou
 * FOR UPDATE. Fonction de compatibilité pour les tests existants et les
 * handlers Connect/refund qui n'ont pas d'agrégat métier à verrouiller avant.
 *
 * Combine `ingestEvent` + `lockWebhookEvent`.
 *
 * @param tx Transaction active.
 * @param event Événement webhook vérifié.
 * @param rawBody Corps brut (pour le hash uniquement).
 * @param environment Environnement Stripe.
 * @param organizationId organization_id résolu (depuis la tentative ou le compte connecté), ou null.
 */
export async function dedupeEvent(
  tx: DatabaseTransaction,
  event: VerifiedWebhookEvent,
  rawBody: string,
  environment: 'TEST' | 'LIVE',
  organizationId: string | null,
): Promise<DedupeResult> {
  const ingest = await ingestEvent(tx, event, rawBody, environment, organizationId);

  if (ingest.organizationId === null) {
    return {
      row: { id: '', status: 'RECEIVED', isDuplicate: false },
      isDuplicate: false,
      organizationId: null,
    };
  }

  const locked = await lockWebhookEvent(tx, ingest.row.id);
  // P1-2 : FAILED est aussi dédupliqué (invariant irréconciliable déjà marqué).
  const isDuplicate =
    locked.status === 'PROCESSED' || locked.status === 'IGNORED' || locked.status === 'FAILED';

  return {
    row: { id: locked.id, status: locked.status, isDuplicate },
    isDuplicate,
    organizationId: ingest.organizationId,
  };
}

/**
 * Marque un événement webhook comme FAILED (erreur d'invariant irréconciliable).
 * Doit être appelée dans la même transaction que la validation qui a échoué,
 * avant de retourner un résultat d'erreur explicite (pas de re-throw, pour que
 * la transaction commit avec l'événement FAILED).
 *
 * P2-3 : Utilise `.returning()` pour vérifier qu'une ligne a été mise à jour.
 * Si aucune ligne n'a été modifiée, c'est que l'événement n'était plus RECEIVED
 * (un worker concurrent l'a traité entre-temps). Retourne `false` dans ce cas
 * pour que le caller puisse logger un avertissement.
 *
 * @param tx Transaction active.
 * @param webhookEventId ID de la ligne payment_webhook_events.
 * @param failureCode Code d'erreur fermé à persister dans `failure_code`.
 * @returns `true` si la ligne a été mise à jour (RECEIVED → FAILED),
 *   `false` si l'événement n'était plus RECEIVED (worker concurrent).
 */
export async function markWebhookFailed(
  tx: DatabaseTransaction,
  webhookEventId: string,
  failureCode: string,
): Promise<boolean> {
  const updated = await tx
    .update(paymentWebhookEvents)
    .set({ status: 'FAILED', failureCode, processedAt: sql`transaction_timestamp()` })
    .where(
      and(eq(paymentWebhookEvents.id, webhookEventId), eq(paymentWebhookEvents.status, 'RECEIVED')),
    )
    .returning({ id: paymentWebhookEvents.id });
  return updated.length > 0;
}

export { resolveOrgFromConnectedAccount };
