/**
 * @uttily/core — Pipeline de génération de documents transactionnels (G5D, ADR-013 §11).
 *
 * Orchestrateur en trois phases pour les événements BOOKING_CONFIRMED.v1 :
 *
 * Phase A — transaction PostgreSQL courte :
 * 1. Claim batch (claimOutboxBatch, incrementStrategy='always' per ADR-013 §7).
 * 2. Pour chaque événement claimé :
 *    a. Valider BOOKING_CONFIRMED.v1 fail-closed. Si invalide → outbox FAILED.
 *    b. Initialiser 4 outbox_effects (ON CONFLICT DO NOTHING).
 *    c. getOrCreateDocumentRenderSnapshotInTx (snapshot figé).
 *    d. Réserver storage_key pour chaque GENERATE_* effect PENDING sans storage_key.
 *    e. Relire les 4 effets avec leur état courant.
 * 3. COMMIT.
 *
 * Phase B — hors transaction (aucun verrou DB) :
 * Pour chaque événement, pour chaque GENERATE_* effect non COMPLETED :
 * 1. Render via DocumentRenderer.
 * 2. Recalculer sizeBytes et SHA-256 depuis le binaire.
 * 3. Vérifier cohérence renderer (checksum/size) → RENDER_FAILED si incohérent.
 * 4. storage.putIfAbsent.
 * 5. Si CREATED → succès. Si ALREADY_EXISTS → vérifier checksum/size/contentType.
 * 6. Si putIfAbsent lève → erreur transitoire, effect reste PENDING.
 *
 * Phase C — transaction PostgreSQL courte :
 * 1. Fencing : SELECT FOR UPDATE avec lease_token + lease_until > now().
 * 2. Si lease perdue → LEASE_LOST, ne pas persister.
 * 3. Lock outbox_effects (FOR UPDATE).
 * 4. Pour chaque GENERATE_* effect :
 *    - Si stockage réussi : INSERT document (ON CONFLICT DO NOTHING), effect COMPLETED.
 *    - Si anomalie durable : effect FAILED avec failure_code.
 * 5. COMMIT.
 *
 * Reschedule (erreurs transitoires) :
 * - Effect reste PENDING, failure_code=NULL.
 * - UPDATE outbox_events SET status='PENDING', lease=NULL, available_at=now()+backoff.
 * - Si attempt_count >= MAX_ATTEMPTS → outbox FAILED.
 *
 * SEND_EMAIL (G5E hors scope) : initialisé PENDING avec document_id=NULL,
 * storage_key=NULL, puis laissé intact.
 */

import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { DatabaseClient } from '@uttily/database';
import type { DocumentRenderer, ObjectStorage } from './ports';
import type { OutboxEffectType, DocumentProcessingFailureCode } from './types';
import {
  EFFECT_TO_DOCUMENT_TYPE,
  EFFECT_TO_TEMPLATE_KEY,
  GENERATE_EFFECTS,
  ALL_EFFECTS,
  effectIdempotencyKey,
  documentIdempotencyKey,
} from './effect-mapping';
import { validateEffectSet } from './effect-validation';
import { getOrCreateDocumentRenderSnapshotInTx } from './get-or-create-document-render-snapshot';
import type { GetOrCreateSnapshotResult } from './get-or-create-document-render-snapshot';
import { parseBookingConfirmedV1 } from './booking-confirmed-parser';
import {
  claimOutboxBatch,
  validateBatchLimit,
  MAX_ATTEMPTS,
  getBackoffIntervalSeconds,
  BOOKING_CONFIRMED_SELECTION,
} from '../outbox-claim';
import type { ClaimEligibility } from '../outbox-claim';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DocumentPipelineResult {
  claimedCount: number;
  completedCount: number;
  failedCount: number;
  rescheduledCount: number;
  leaseLostCount: number;
  anomalies: Array<{ outboxEventId: string; effectType: string; failureCode: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase A — transaction courte
// ─────────────────────────────────────────────────────────────────────────────

interface EffectRow {
  id: string;
  effectType: OutboxEffectType;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  documentId: string | null;
  storageKey: string | null;
  idempotencyKey: string;
}

interface PhaseAResult {
  outboxEventId: string;
  organizationId: string;
  leaseToken: string;
  attemptCount: number;
  snapshot: GetOrCreateSnapshotResult;
  effects: EffectRow[];
  payloadMalformed: boolean;
}

async function phaseAClaimAndInit(
  db: DatabaseClient,
  batchLimit: number,
): Promise<{ results: PhaseAResult[]; totalClaimed: number; malformedCount: number }> {
  return await db.transaction(async (tx) => {
    const claimed = await claimOutboxBatch(
      tx,
      BOOKING_CONFIRMED_SELECTION,
      batchLimit,
      'always',
      'INCOMPLETE_DOCUMENT_GENERATION' as ClaimEligibility,
    );

    if (claimed.length === 0) return { results: [], totalClaimed: 0, malformedCount: 0 };

    const results: PhaseAResult[] = [];
    let malformedCount = 0;

    for (const event of claimed) {
      // isolation par événement via savepoint (tx.transaction()).
      // Un événement corrompu (snapshot manquant, erreur d'init) ne doit pas
      // aborter tout le batch. Le savepoint est annulé automatiquement par le
      // driver en cas d'erreur, puis on marque l'événement FAILED dans la
      // transaction extérieure (qui commit).
      let phaseAResult: PhaseAResult | null = null;
      let eventFailed = false;

      try {
        phaseAResult = await tx.transaction(async (sp) => {
          // a. Valider BOOKING_CONFIRMED.v1 fail-closed.
          let payloadMalformed = false;
          try {
            parseBookingConfirmedV1({
              id: event.outboxEventId,
              organizationId: event.organizationId,
              aggregateType: event.aggregateType,
              aggregateId: event.aggregateId,
              eventType: event.eventType,
              eventVersion: event.eventVersion,
              payload: event.payload,
            });
          } catch {
            // Payload mal formé → marquer outbox FAILED dans le savepoint.
            payloadMalformed = true;
            await sp.execute(sql`
              UPDATE "outbox_events"
              SET "status" = 'FAILED',
                  "lease_token" = NULL,
                  "lease_until" = NULL
              WHERE "id" = ${event.outboxEventId}::uuid
                AND "lease_token" = ${event.leaseToken}::uuid
            `);
            // Pas d'effets à initialiser pour un payload mal formé.
            return {
              outboxEventId: event.outboxEventId,
              organizationId: event.organizationId,
              leaseToken: event.leaseToken,
              attemptCount: event.attemptCount,
              snapshot: {} as GetOrCreateSnapshotResult,
              effects: [],
              payloadMalformed,
            } as PhaseAResult;
          }

          // b. Initialiser 4 outbox_effects avec ON CONFLICT DO NOTHING.
          // ON CONFLICT (outbox_event_id, effect_type) — le conflit
          // métier est (outbox_event_id, effect_type), pas idempotency_key.
          for (const effectType of ALL_EFFECTS) {
            const idempotencyKey = effectIdempotencyKey(event.outboxEventId, effectType);
            await sp.execute(sql`
              INSERT INTO "outbox_effects" (
                "organization_id", "outbox_event_id", "effect_type",
                "status", "document_id", "storage_key", "idempotency_key"
              ) VALUES (
                ${event.organizationId}::uuid,
                ${event.outboxEventId}::uuid,
                ${effectType}::outbox_effect_type,
                'PENDING'::outbox_effect_status,
                NULL,
                NULL,
                ${idempotencyKey}
              )
              ON CONFLICT ("outbox_event_id", "effect_type") DO NOTHING
            `);
          }

          // c. getOrCreateDocumentRenderSnapshotInTx (snapshot figé).
          const snapshot = await getOrCreateDocumentRenderSnapshotInTx(sp, {
            outboxEventId: event.outboxEventId,
            organizationId: event.organizationId,
          });

          // d. Réserver storage_key pour chaque GENERATE_* effect PENDING sans storage_key.
          for (const effectType of GENERATE_EFFECTS) {
            const storageKey = crypto.randomUUID();
            await sp.execute(sql`
              UPDATE "outbox_effects"
              SET "storage_key" = ${storageKey}
              WHERE "outbox_event_id" = ${event.outboxEventId}::uuid
                AND "organization_id" = ${event.organizationId}::uuid
                AND "effect_type" = ${effectType}::outbox_effect_type
                AND "storage_key" IS NULL
                AND "status" = 'PENDING'
            `);
          }

          // e. Relire les 4 effets avec leur état courant.
          const effectRows = await sp.execute(sql`
            SELECT "id", "effect_type", "status", "document_id", "storage_key", "idempotency_key"
            FROM "outbox_effects"
            WHERE "outbox_event_id" = ${event.outboxEventId}::uuid
              AND "organization_id" = ${event.organizationId}::uuid
            ORDER BY "effect_type" ASC
          `);
          const effects = (
            effectRows as unknown as Array<{
              id: string;
              effect_type: OutboxEffectType;
              status: 'PENDING' | 'COMPLETED' | 'FAILED';
              document_id: string | null;
              storage_key: string | null;
              idempotency_key: string;
            }>
          ).map((r) => ({
            id: r.id,
            effectType: r.effect_type,
            status: r.status,
            documentId: r.document_id,
            storageKey: r.storage_key,
            idempotencyKey: r.idempotency_key,
          }));

          // valider les invariants de l'ensemble d'effets via la fonction pure partagée.
          validateEffectSet({ effects, outboxEventId: event.outboxEventId });

          return {
            outboxEventId: event.outboxEventId,
            organizationId: event.organizationId,
            leaseToken: event.leaseToken,
            attemptCount: event.attemptCount,
            snapshot,
            effects,
            payloadMalformed,
          } as PhaseAResult;
        });
      } catch {
        // le savepoint a été annulé automatiquement par le driver.
        // Marquer cet événement comme FAILED dans la transaction extérieure.
        eventFailed = true;
        await tx.execute(sql`
          UPDATE "outbox_events"
          SET "status" = 'FAILED',
              "lease_token" = NULL,
              "lease_until" = NULL
          WHERE "id" = ${event.outboxEventId}::uuid
            AND "lease_token" = ${event.leaseToken}::uuid
        `);
        malformedCount++;
      }

      if (eventFailed) continue;
      if (phaseAResult) {
        if (phaseAResult.payloadMalformed) {
          malformedCount++;
        }
        results.push(phaseAResult);
      }
    }

    return { results, totalClaimed: claimed.length, malformedCount };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase B — hors transaction
// ─────────────────────────────────────────────────────────────────────────────

type StorageOutcome =
  | { kind: 'SUCCESS'; checksumSha256: string; sizeBytes: number; contentType: string }
  | { kind: 'DURABLE_FAILURE'; failureCode: DocumentProcessingFailureCode }
  | { kind: 'TRANSIENT_FAILURE'; transientFailureCode: DocumentProcessingFailureCode };

interface PhaseBEffectResult {
  effectType: OutboxEffectType;
  effectId: string;
  storageKey: string;
  outcome: StorageOutcome;
}

interface PhaseBEventResult {
  outboxEventId: string;
  organizationId: string;
  leaseToken: string;
  attemptCount: number;
  effectResults: PhaseBEffectResult[];
  hasTransientError: boolean;
  leaseLost: boolean;
  payloadMalformed: boolean;
}

function computeSha256(content: Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(content);
  return hash.digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// reserveEffectAttempt — réservation courte par effet (fenced tx)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Réservation d'une tentative d'effet avant l'appel externe (render/storage).
 *
 * outbox_effects.attempt_count doit être incrémenté UNIQUEMENT
 * lorsque l'effet est réellement tenté (pas lors du claim de l'événement).
 *
 * Cette fonction ouvre une COURTE TRANSACTION FENCED par effet, AVANT l'appel
 * externe (render/storage). Elle vérifie :
 * 1. L'événement outbox existe, organization_id correspond, lease_token
 *    correspond, lease_until > now().
 * 2. L'effet existe, outbox_event_id correspond, organization_id correspond,
 *    effect_type correspond, status = 'PENDING'.
 * Si OK → incrémente outbox_effects.attempt_count de 1 et commit.
 *
 * AUCUN appel externe dans cette transaction.
 *
 * Petite fenêtre de crash : entre cette réservation et l'appel externe, un
 * crash du worker laisse l'effet PENDING avec attempt_count déjà incrémenté.
 * C'est acceptable : le retry suivant incrémentera à nouveau (at-least-once).
 * L'attempt_count de l'effet n'est pas un compteur exact de tentatives
 * réussies, mais un compteur de réservations — un incrément supplémentaire
 * n'entraîne pas de transition prématurée vers FAILED (seul outbox_events
 * .attempt_count déclenche le FAILED après 5 claims).
 */
export async function reserveEffectAttempt(
  db: DatabaseClient,
  params: {
    readonly outboxEventId: string;
    readonly organizationId: string;
    readonly leaseToken: string;
    readonly effectId: string;
    readonly effectType: OutboxEffectType;
  },
): Promise<
  | { reserved: true; effectAttemptCount: number }
  | { reserved: false; reason: 'LEASE_LOST' | 'NOT_PENDING' }
> {
  return await db.transaction(async (tx) => {
    // 1. Vérifier le lease de l'événement outbox (fencing).
    const eventRows = await tx.execute(sql`
      SELECT "id" FROM "outbox_events"
      WHERE "id" = ${params.outboxEventId}::uuid
        AND "organization_id" = ${params.organizationId}::uuid
        AND "lease_token" = ${params.leaseToken}::uuid
        AND "lease_until" > transaction_timestamp()
      FOR UPDATE
    `);
    if ((eventRows as unknown as Array<{ id: string }>).length === 0) {
      return { reserved: false, reason: 'LEASE_LOST' as const };
    }

    // 2. Vérifier l'effet : PENDING, matching IDs et effect_type.
    const effectRows = await tx.execute(sql`
      SELECT "id", "attempt_count" FROM "outbox_effects"
      WHERE "id" = ${params.effectId}::uuid
        AND "outbox_event_id" = ${params.outboxEventId}::uuid
        AND "organization_id" = ${params.organizationId}::uuid
        AND "effect_type" = ${params.effectType}::outbox_effect_type
        AND "status" = 'PENDING'
      FOR UPDATE
    `);
    const effectRow = (
      effectRows as unknown as Array<{
        id: string;
        attempt_count: number;
      }>
    )[0];
    if (!effectRow) {
      return { reserved: false, reason: 'NOT_PENDING' as const };
    }

    // 3. Incrémenter outbox_effects.attempt_count.
    const updated = await tx.execute(sql`
      UPDATE "outbox_effects"
      SET "attempt_count" = "attempt_count" + 1
      WHERE "id" = ${params.effectId}::uuid
      RETURNING "attempt_count"
    `);
    const newCount = (updated as unknown as Array<{ attempt_count: number }>)[0]!.attempt_count;

    return { reserved: true, effectAttemptCount: newCount };
  });
}

async function phaseBRenderAndStore(
  db: DatabaseClient,
  renderer: DocumentRenderer,
  storage: ObjectStorage,
  phaseAResults: PhaseAResult[],
): Promise<PhaseBEventResult[]> {
  const results: PhaseBEventResult[] = [];

  for (const eventResult of phaseAResults) {
    if (eventResult.payloadMalformed) {
      // Pas de Phase B pour les payloads mal formés (déjà marqués FAILED en Phase A).
      results.push({
        outboxEventId: eventResult.outboxEventId,
        organizationId: eventResult.organizationId,
        leaseToken: eventResult.leaseToken,
        attemptCount: eventResult.attemptCount,
        effectResults: [],
        hasTransientError: false,
        leaseLost: false,
        payloadMalformed: true,
      });
      continue;
    }

    const snapshot = eventResult.snapshot.snapshot;
    const effectResults: PhaseBEffectResult[] = [];
    let hasTransientError = false;
    let leaseLost = false;

    for (const effect of eventResult.effects) {
      // Skip non-GENERATE effects, COMPLETED, and FAILED effects.
      // seuls les effets PENDING sont retraités. COMPLETED et FAILED
      // sont définitivement exclus du rejeu.
      if (!GENERATE_EFFECTS.includes(effect.effectType)) continue;
      if (effect.status !== 'PENDING') continue;
      if (!effect.storageKey) continue;

      const templateKey = EFFECT_TO_TEMPLATE_KEY[effect.effectType]!;

      // réserver la tentative d'effet (short fenced tx) AVANT
      // l'appel externe. Incrémente outbox_effects.attempt_count.
      const reservation = await reserveEffectAttempt(db, {
        outboxEventId: eventResult.outboxEventId,
        organizationId: eventResult.organizationId,
        leaseToken: eventResult.leaseToken,
        effectId: effect.id,
        effectType: effect.effectType,
      });
      if (!reservation.reserved) {
        if (reservation.reason === 'LEASE_LOST') {
          // Lease perdue → stop processing this event immediately.
          // Do NOT attempt any other effects. Do NOT push TRANSIENT_FAILURE.
          leaseLost = true;
          break;
        }
        // NOT_PENDING → effect already terminal, skip to next effect.
        // Phase C will re-read authoritative state and finalize.
        continue;
      }

      // 1. Render.
      let rendered;
      try {
        rendered = await renderer.render(templateKey, snapshot);
      } catch {
        // Renderer threw — transient failure (renderer is expected to be
        // deterministic; a throw is a technical failure that may resolve on retry).
        hasTransientError = true;
        effectResults.push({
          effectType: effect.effectType,
          effectId: effect.id,
          storageKey: effect.storageKey,
          outcome: { kind: 'TRANSIENT_FAILURE', transientFailureCode: 'RENDER_FAILED' },
        });
        continue;
      }

      // 2. Recalculer sizeBytes et SHA-256 depuis le binaire.
      const recalculatedChecksum = computeSha256(rendered.content);
      const recalculatedSize = rendered.content.length;

      // 3. Vérifier cohérence renderer (checksum/size).
      if (
        rendered.checksumSha256 !== recalculatedChecksum ||
        rendered.sizeBytes !== recalculatedSize
      ) {
        // Renderer inconsistency — durable failure.
        effectResults.push({
          effectType: effect.effectType,
          effectId: effect.id,
          storageKey: effect.storageKey,
          outcome: { kind: 'DURABLE_FAILURE', failureCode: 'RENDER_FAILED' },
        });
        continue;
      }

      // 4. storage.putIfAbsent.
      let putResult;
      try {
        putResult = await storage.putIfAbsent({
          key: effect.storageKey,
          content: rendered.content,
          contentType: rendered.contentType,
          checksumSha256: recalculatedChecksum,
          sizeBytes: recalculatedSize,
        });
      } catch {
        // putIfAbsent threw — transient storage error.
        hasTransientError = true;
        effectResults.push({
          effectType: effect.effectType,
          effectId: effect.id,
          storageKey: effect.storageKey,
          outcome: { kind: 'TRANSIENT_FAILURE', transientFailureCode: 'STORAGE_PUT_FAILED' },
        });
        continue;
      }

      if (putResult.kind === 'CREATED') {
        effectResults.push({
          effectType: effect.effectType,
          effectId: effect.id,
          storageKey: effect.storageKey,
          outcome: {
            kind: 'SUCCESS',
            checksumSha256: recalculatedChecksum,
            sizeBytes: recalculatedSize,
            contentType: rendered.contentType,
          },
        });
      } else {
        // ALREADY_EXISTS — appeler storage.head() pour vérifier
        // les métadonnées de l'objet existant (hors transaction, Phase B).
        // Ne JAMAIS utiliser putResult.metadata directement.
        let headMeta;
        try {
          headMeta = await storage.head(effect.storageKey);
        } catch {
          // head() a levé → erreur transitoire (pas STORAGE_NOT_FOUND).
          hasTransientError = true;
          effectResults.push({
            effectType: effect.effectType,
            effectId: effect.id,
            storageKey: effect.storageKey,
            outcome: { kind: 'TRANSIENT_FAILURE', transientFailureCode: 'STORAGE_PUT_FAILED' },
          });
          continue;
        }

        // head null → l'objet n'existe pas réellement → STORAGE_NOT_FOUND.
        if (headMeta === null) {
          effectResults.push({
            effectType: effect.effectType,
            effectId: effect.id,
            storageKey: effect.storageKey,
            outcome: { kind: 'DURABLE_FAILURE', failureCode: 'STORAGE_NOT_FOUND' },
          });
          continue;
        }

        // a. Comparer contentType et sizeBytes d'abord.
        if (
          headMeta.contentType !== rendered.contentType ||
          headMeta.sizeBytes !== recalculatedSize
        ) {
          // Mismatch → anomalie durable.
          effectResults.push({
            effectType: effect.effectType,
            effectId: effect.id,
            storageKey: effect.storageKey,
            outcome: { kind: 'DURABLE_FAILURE', failureCode: 'STORAGE_CHECKSUM_MISMATCH' },
          });
          continue;
        }

        // b. Si checksumSha256 est non-null → comparer le checksum.
        if (headMeta.checksumSha256 !== null) {
          if (headMeta.checksumSha256 === recalculatedChecksum) {
            // Replay safe — checksum, size, contentType tous identiques.
            effectResults.push({
              effectType: effect.effectType,
              effectId: effect.id,
              storageKey: effect.storageKey,
              outcome: {
                kind: 'SUCCESS',
                checksumSha256: recalculatedChecksum,
                sizeBytes: recalculatedSize,
                contentType: rendered.contentType,
              },
            });
          } else {
            // Checksum mismatch → anomalie durable.
            effectResults.push({
              effectType: effect.effectType,
              effectId: effect.id,
              storageKey: effect.storageKey,
              outcome: { kind: 'DURABLE_FAILURE', failureCode: 'STORAGE_CHECKSUM_MISMATCH' },
            });
          }
          continue;
        }

        // c. checksumSha256 est null → appeler storage.get() et recalculer.
        try {
          const retrievedContent = await storage.get(effect.storageKey);
          // Vérifier que la taille du contenu récupéré correspond à head.sizeBytes.
          if (retrievedContent.length !== headMeta.sizeBytes) {
            effectResults.push({
              effectType: effect.effectType,
              effectId: effect.id,
              storageKey: effect.storageKey,
              outcome: { kind: 'DURABLE_FAILURE', failureCode: 'STORAGE_CHECKSUM_MISMATCH' },
            });
            continue;
          }
          const retrievedChecksum = computeSha256(retrievedContent);
          if (retrievedChecksum === recalculatedChecksum) {
            effectResults.push({
              effectType: effect.effectType,
              effectId: effect.id,
              storageKey: effect.storageKey,
              outcome: {
                kind: 'SUCCESS',
                checksumSha256: recalculatedChecksum,
                sizeBytes: recalculatedSize,
                contentType: rendered.contentType,
              },
            });
          } else {
            effectResults.push({
              effectType: effect.effectType,
              effectId: effect.id,
              storageKey: effect.storageKey,
              outcome: { kind: 'DURABLE_FAILURE', failureCode: 'STORAGE_CHECKSUM_MISMATCH' },
            });
          }
        } catch {
          // storage.get() a levé → erreur transitoire (pas STORAGE_NOT_FOUND
          // automatiquement — seulement si l'objet est vraiment absent).
          hasTransientError = true;
          effectResults.push({
            effectType: effect.effectType,
            effectId: effect.id,
            storageKey: effect.storageKey,
            outcome: { kind: 'TRANSIENT_FAILURE', transientFailureCode: 'STORAGE_PUT_FAILED' },
          });
        }
      }
    }

    results.push({
      outboxEventId: eventResult.outboxEventId,
      organizationId: eventResult.organizationId,
      leaseToken: eventResult.leaseToken,
      attemptCount: eventResult.attemptCount,
      effectResults,
      hasTransientError,
      leaseLost,
      payloadMalformed: false,
    });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase C — transaction courte (persistance)
// ─────────────────────────────────────────────────────────────────────────────

interface PersistedTransition {
  effectId: string;
  effectType: string;
  newStatus: 'COMPLETED' | 'FAILED';
  failureCode: string | null;
}

async function phaseCPersist(
  db: DatabaseClient,
  phaseBResults: PhaseBEventResult[],
  phaseAResults: PhaseAResult[],
): Promise<{
  completedCount: number;
  failedCount: number;
  leaseLostCount: number;
  anomalies: Array<{ outboxEventId: string; effectType: string; failureCode: string }>;
}> {
  let completedCount = 0;
  let failedCount = 0;
  let leaseLostCount = 0;
  const anomalies: Array<{ outboxEventId: string; effectType: string; failureCode: string }> = [];

  // Map for quick lookup of snapshot info.
  const phaseAMap = new Map(phaseAResults.map((r) => [r.outboxEventId, r]));

  for (const eventResult of phaseBResults) {
    if (eventResult.payloadMalformed) {
      // Payload-malformed events were already finalized in Phase A.
      continue;
    }
    if (eventResult.leaseLost) {
      // Lease lost during Phase B — skip Phase C, don't reschedule with old token.
      leaseLostCount++;
      continue;
    }

    const phaseA = phaseAMap.get(eventResult.outboxEventId);
    if (!phaseA) continue;

    const result = await db.transaction(
      async (tx): Promise<{ status: 'OK' | 'LEASE_LOST'; transitions: PersistedTransition[] }> => {
        // 1. Fencing check.
        const fenceRows = await tx.execute(sql`
        SELECT "id" FROM "outbox_events"
        WHERE "id" = ${eventResult.outboxEventId}::uuid
          AND "organization_id" = ${eventResult.organizationId}::uuid
          AND "lease_token" = ${eventResult.leaseToken}::uuid
          AND "lease_until" > transaction_timestamp()
        FOR UPDATE
      `);
        if ((fenceRows as unknown as Array<{ id: string }>).length === 0) {
          return { status: 'LEASE_LOST' as const, transitions: [] };
        }

        // 3. Lock outbox_effects.
        await tx.execute(sql`
        SELECT "id" FROM "outbox_effects"
        WHERE "outbox_event_id" = ${eventResult.outboxEventId}::uuid
          AND "organization_id" = ${eventResult.organizationId}::uuid
        FOR UPDATE
      `);

        // 3b. Re-read full effect rows and validate invariants via the shared
        // pure function (same checks as Phase A). If validation fails, fail
        // closed: mark outbox FAILED, clean lease, do NOT process effects.
        const validationRows = await tx.execute(sql`
        SELECT "effect_type", "status", "document_id", "storage_key", "idempotency_key"
        FROM "outbox_effects"
        WHERE "outbox_event_id" = ${eventResult.outboxEventId}::uuid
          AND "organization_id" = ${eventResult.organizationId}::uuid
      `);
        const validationEffects = (
          validationRows as unknown as Array<{
            effect_type: OutboxEffectType;
            status: string;
            document_id: string | null;
            storage_key: string | null;
            idempotency_key: string;
          }>
        ).map((r) => ({
          effectType: r.effect_type,
          status: r.status,
          documentId: r.document_id,
          storageKey: r.storage_key,
          idempotencyKey: r.idempotency_key,
        }));

        try {
          validateEffectSet({
            effects: validationEffects,
            outboxEventId: eventResult.outboxEventId,
          });
        } catch {
          // Invariant violation → fail closed. Mark outbox FAILED, clean lease.
          // Do NOT process any effects, do NOT perform external operations.
          await tx.execute(sql`
          UPDATE "outbox_events"
          SET "status" = 'FAILED',
              "lease_token" = NULL,
              "lease_until" = NULL,
              "processed_at" = NULL
          WHERE "id" = ${eventResult.outboxEventId}::uuid
            AND "lease_token" = ${eventResult.leaseToken}::uuid
        `);
          return { status: 'OK' as const, transitions: [] };
        }

        const transitions: PersistedTransition[] = [];

        // 4. For each GENERATE_* effect with a result.
        // les UPDATE outbox_effects filtrent par effect ID,
        // organization_id, outbox_event_id, effect_type, status='PENDING' et
        // storage_key (pour GENERATE_*). On vérifie le nombre de lignes
        // réellement modifiées pour ne pas incrémenter completedCount/
        // failedCount à tort.
        for (const effectResult of eventResult.effectResults) {
          if (effectResult.outcome.kind === 'SUCCESS') {
            const documentType = EFFECT_TO_DOCUMENT_TYPE[effectResult.effectType]!;
            const docIdempotencyKey = documentIdempotencyKey(
              eventResult.outboxEventId,
              documentType,
            );
            // Capture outcome fields before try/catch so TypeScript can narrow the type.
            const { contentType, checksumSha256, sizeBytes } = effectResult.outcome;

            // INSERT document with ON CONFLICT DO NOTHING, wrapped in a savepoint
            // to handle collisions on (booking_id, type, version) or storage_key
            // unique constraints without aborting the entire Phase C transaction.
            let docId: string | null = null;
            let docInsertFailed = false;
            try {
              docId = await tx.transaction(async (sp) => {
                const docRows = await sp.execute(sql`
                INSERT INTO "documents" (
                  "organization_id", "booking_id", "type", "version",
                  "storage_key", "content_type", "checksum_sha256", "size_bytes",
                  "template_version", "generated_at",
                  "source_outbox_event_id", "render_snapshot_id", "idempotency_key"
                ) VALUES (
                  ${eventResult.organizationId}::uuid,
                  ${phaseA.snapshot.snapshot.bookingId}::uuid,
                  ${documentType}::document_type,
                  1,
                  ${effectResult.storageKey},
                  ${contentType},
                  ${checksumSha256},
                  ${sizeBytes},
                  'v1',
                  transaction_timestamp(),
                  ${eventResult.outboxEventId}::uuid,
                  ${phaseA.snapshot.snapshotId}::uuid,
                  ${docIdempotencyKey}
                )
                ON CONFLICT ("idempotency_key") DO NOTHING
                RETURNING "id"
              `);
                return (docRows as unknown as Array<{ id: string }>)[0]?.id ?? null;
              });
            } catch {
              // Collision on (booking_id, type, version) or storage_key.
              // The savepoint was rolled back, tx is still usable.
              docInsertFailed = true;
            }

            let finalDocId = docId;
            let docMismatch = false;

            if (docInsertFailed) {
              // Search for existing documents by the OTHER unique keys.
              // By (booking_id, type, version) and by storage_key.
              const existingByBookingType = await tx.execute(sql`
              SELECT
                "id", "organization_id", "booking_id", "type", "version",
                "storage_key", "content_type", "checksum_sha256", "size_bytes",
                "template_version", "source_outbox_event_id", "render_snapshot_id"
              FROM "documents"
              WHERE "booking_id" = ${phaseA.snapshot.snapshot.bookingId}::uuid
                AND "type" = ${documentType}::document_type
                AND "version" = 1
            `);
              const existingByStorageKey = await tx.execute(sql`
              SELECT
                "id", "organization_id", "booking_id", "type", "version",
                "storage_key", "content_type", "checksum_sha256", "size_bytes",
                "template_version", "source_outbox_event_id", "render_snapshot_id"
              FROM "documents"
              WHERE "storage_key" = ${effectResult.storageKey}
            `);
              const candidates = [
                ...(existingByBookingType as unknown as Array<Record<string, unknown>>),
                ...(existingByStorageKey as unknown as Array<Record<string, unknown>>),
              ];
              let perfectMatch: string | null = null;
              for (const c of candidates) {
                if (
                  c['organization_id'] === eventResult.organizationId &&
                  c['booking_id'] === phaseA.snapshot.snapshot.bookingId &&
                  c['type'] === documentType &&
                  Number(c['version']) === 1 &&
                  c['storage_key'] === effectResult.storageKey &&
                  c['content_type'] === contentType &&
                  c['checksum_sha256'] === checksumSha256 &&
                  Number(c['size_bytes']) === sizeBytes &&
                  c['template_version'] === 'v1' &&
                  c['source_outbox_event_id'] === eventResult.outboxEventId &&
                  c['render_snapshot_id'] === phaseA.snapshot.snapshotId
                ) {
                  perfectMatch = c['id'] as string;
                  break;
                }
              }
              if (perfectMatch) {
                finalDocId = perfectMatch;
              } else {
                docMismatch = true;
              }
            } else if (!finalDocId) {
              // Document déjà existant (idempotency_key conflict) — recouper TOUS les champs.
              const existingDoc = await tx.execute(sql`
              SELECT
                "id", "organization_id", "booking_id", "type", "version",
                "storage_key", "content_type", "checksum_sha256", "size_bytes",
                "template_version", "source_outbox_event_id", "render_snapshot_id"
              FROM "documents"
              WHERE "idempotency_key" = ${docIdempotencyKey}
            `);
              const existing = (
                existingDoc as unknown as Array<{
                  id: string;
                  organization_id: string;
                  booking_id: string;
                  type: string;
                  version: number;
                  storage_key: string;
                  content_type: string;
                  checksum_sha256: string;
                  size_bytes: number;
                  template_version: string;
                  source_outbox_event_id: string;
                  render_snapshot_id: string;
                }>
              )[0];
              if (!existing) {
                // Document disparu entre INSERT et SELECT — ne pas attacher.
                docMismatch = true;
              } else {
                // Comparer chaque champ avec les valeurs attendues.
                // Note: size_bytes est bigint → le driver postgres le retourne
                // en string, donc on utilise Number() pour la comparaison.
                if (
                  existing.organization_id !== eventResult.organizationId ||
                  existing.booking_id !== phaseA.snapshot.snapshot.bookingId ||
                  existing.type !== documentType ||
                  existing.version !== 1 ||
                  existing.storage_key !== effectResult.storageKey ||
                  existing.content_type !== contentType ||
                  existing.checksum_sha256 !== checksumSha256 ||
                  Number(existing.size_bytes) !== sizeBytes ||
                  existing.template_version !== 'v1' ||
                  existing.source_outbox_event_id !== eventResult.outboxEventId ||
                  existing.render_snapshot_id !== phaseA.snapshot.snapshotId
                ) {
                  docMismatch = true;
                } else {
                  finalDocId = existing.id;
                }
              }
            }

            if (docMismatch) {
              // mismatch → anomalie durable, ne pas marquer COMPLETED.
              const failRows = await tx.execute(sql`
              UPDATE "outbox_effects"
              SET "status" = 'FAILED',
                  "completed_at" = transaction_timestamp(),
                  "failure_code" = 'STORAGE_CHECKSUM_MISMATCH'::document_processing_failure_code
              WHERE "id" = ${effectResult.effectId}::uuid
                AND "organization_id" = ${eventResult.organizationId}::uuid
                AND "outbox_event_id" = ${eventResult.outboxEventId}::uuid
                AND "effect_type" = ${effectResult.effectType}::outbox_effect_type
                AND "status" = 'PENDING'
                AND "storage_key" = ${effectResult.storageKey}
              RETURNING "id"
            `);
              if ((failRows as unknown as Array<{ id: string }>).length > 0) {
                transitions.push({
                  effectId: effectResult.effectId,
                  effectType: effectResult.effectType,
                  newStatus: 'FAILED',
                  failureCode: 'STORAGE_CHECKSUM_MISMATCH',
                });
              }
            } else if (finalDocId) {
              // UPDATE effect → COMPLETED avec filtres complets.
              const updateRows = await tx.execute(sql`
              UPDATE "outbox_effects"
              SET "status" = 'COMPLETED',
                  "document_id" = ${finalDocId}::uuid,
                  "completed_at" = transaction_timestamp(),
                  "failure_code" = NULL
              WHERE "id" = ${effectResult.effectId}::uuid
                AND "organization_id" = ${eventResult.organizationId}::uuid
                AND "outbox_event_id" = ${eventResult.outboxEventId}::uuid
                AND "effect_type" = ${effectResult.effectType}::outbox_effect_type
                AND "status" = 'PENDING'
                AND "storage_key" = ${effectResult.storageKey}
              RETURNING "id"
            `);
              if ((updateRows as unknown as Array<{ id: string }>).length > 0) {
                transitions.push({
                  effectId: effectResult.effectId,
                  effectType: effectResult.effectType,
                  newStatus: 'COMPLETED',
                  failureCode: null,
                });
              }
            }
          } else if (effectResult.outcome.kind === 'DURABLE_FAILURE') {
            // UPDATE effect → FAILED avec filtres complets.
            const failRows = await tx.execute(sql`
            UPDATE "outbox_effects"
            SET "status" = 'FAILED',
                "completed_at" = transaction_timestamp(),
                "failure_code" = ${effectResult.outcome.failureCode}::document_processing_failure_code
            WHERE "id" = ${effectResult.effectId}::uuid
              AND "organization_id" = ${eventResult.organizationId}::uuid
              AND "outbox_event_id" = ${eventResult.outboxEventId}::uuid
              AND "effect_type" = ${effectResult.effectType}::outbox_effect_type
              AND "status" = 'PENDING'
              AND "storage_key" = ${effectResult.storageKey}
            RETURNING "id"
          `);
            if ((failRows as unknown as Array<{ id: string }>).length > 0) {
              transitions.push({
                effectId: effectResult.effectId,
                effectType: effectResult.effectType,
                newStatus: 'FAILED',
                failureCode: effectResult.outcome.failureCode,
              });
            }
          }
          // TRANSIENT_FAILURE: effect stays PENDING, handled by reschedule below.
        }

        // Finalisation from authoritative DB state.
        // Re-read ALL 4 effects from PostgreSQL (authoritative state) with full
        // columns (not just effect_type and status) while still holding the
        // outbox_effects FOR UPDATE locks.
        const allEffects = await tx.execute(sql`
        SELECT "effect_type", "status", "document_id", "storage_key", "idempotency_key"
        FROM "outbox_effects"
        WHERE "outbox_event_id" = ${eventResult.outboxEventId}::uuid
          AND "organization_id" = ${eventResult.organizationId}::uuid
      `);
        const effectStatuses = allEffects as unknown as Array<{
          effect_type: string;
          status: string;
        }>;

        const hasFailed = effectStatuses.some((e) => e.status === 'FAILED');
        const generateCompleted = effectStatuses.filter(
          (e) =>
            (e.effect_type === 'GENERATE_CONFIRMATION' ||
              e.effect_type === 'GENERATE_CONTRACT' ||
              e.effect_type === 'GENERATE_RECEIPT') &&
            e.status === 'COMPLETED',
        ).length;
        const sendEmailPending = effectStatuses.some(
          (e) => e.effect_type === 'SEND_EMAIL' && e.status === 'PENDING',
        );

        if (hasFailed) {
          // At least one effect terminal FAILED → outbox FAILED.
          await tx.execute(sql`
          UPDATE "outbox_events"
          SET "status" = 'FAILED',
              "lease_token" = NULL,
              "lease_until" = NULL
          WHERE "id" = ${eventResult.outboxEventId}::uuid
            AND "lease_token" = ${eventResult.leaseToken}::uuid
        `);
        } else if (generateCompleted === 3 && sendEmailPending) {
          // All 3 GENERATE_* COMPLETED and SEND_EMAIL PENDING → outbox PENDING
          // for G5E, immediately available (no arbitrary delay).
          await tx.execute(sql`
          UPDATE "outbox_events"
          SET "status" = 'PENDING',
              "lease_token" = NULL,
              "lease_until" = NULL,
              "available_at" = transaction_timestamp()
          WHERE "id" = ${eventResult.outboxEventId}::uuid
            AND "lease_token" = ${eventResult.leaseToken}::uuid
        `);
        }
        // If any effect is still PENDING (transient) → don't finalize here,
        // let reschedule handle it. NEVER mark PROCESSED in G5D.

        return { status: 'OK' as const, transitions };
      },
    );

    if (result.status === 'LEASE_LOST') {
      leaseLostCount++;
      continue;
    }

    // Build counters ONLY from transactional results (no re-read outside tx).
    for (const t of result.transitions) {
      if (t.newStatus === 'COMPLETED') {
        completedCount++;
      } else if (t.newStatus === 'FAILED') {
        failedCount++;
        anomalies.push({
          outboxEventId: eventResult.outboxEventId,
          effectType: t.effectType,
          failureCode: t.failureCode ?? 'UNKNOWN_ERROR',
        });
      }
    }
  }

  return { completedCount, failedCount, leaseLostCount, anomalies };
}

// phaseCPersist est privée à ce module. Les tests de fencing (scénario 14)
// utilisent le vrai pipeline avec onAfterPhaseB + barrière, pas d'appel direct.

// ─────────────────────────────────────────────────────────────────────────────
// Reschedule (erreurs transitoires)
// ─────────────────────────────────────────────────────────────────────────────

async function rescheduleTransientErrors(
  db: DatabaseClient,
  phaseBResults: PhaseBEventResult[],
): Promise<number> {
  let rescheduledCount = 0;

  for (const eventResult of phaseBResults) {
    if (!eventResult.hasTransientError) continue;
    if (eventResult.leaseLost) continue;

    // Check if max attempts reached.
    if (eventResult.attemptCount >= MAX_ATTEMPTS) {
      // Mark outbox FAILED — max attempts reached.
      await db.transaction(async (tx) => {
        const rows = await tx.execute(sql`
          UPDATE "outbox_events"
          SET "status" = 'FAILED',
              "lease_token" = NULL,
              "lease_until" = NULL
          WHERE "id" = ${eventResult.outboxEventId}::uuid
            AND "lease_token" = ${eventResult.leaseToken}::uuid
          RETURNING "id"
        `);
        if ((rows as unknown as Array<{ id: string }>).length > 0) {
          // Also mark transient-failed effects as FAILED with their
          // original transientFailureCode from the last attempt.
          for (const effectResult of eventResult.effectResults) {
            if (effectResult.outcome.kind === 'TRANSIENT_FAILURE') {
              await tx.execute(sql`
                UPDATE "outbox_effects"
                SET "status" = 'FAILED',
                    "completed_at" = transaction_timestamp(),
                    "failure_code" = ${effectResult.outcome.transientFailureCode}::document_processing_failure_code
                WHERE "id" = ${effectResult.effectId}::uuid
                  AND "status" = 'PENDING'
              `);
            }
          }
        }
      });
      continue;
    }

    // Reschedule with backoff. Do NOT increment attempt_count (already
    // incremented by the claim per ADR-013 §7).
    // backoff utilise attemptCount - 1 (0-indexé).
    // Après le 1er claim, attemptCount=1 → backoff=30*2^0=30s (pas 60s).
    const backoffSeconds = getBackoffIntervalSeconds(Math.max(0, eventResult.attemptCount - 1));
    const rows = await db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        UPDATE "outbox_events"
        SET "status" = 'PENDING',
            "lease_token" = NULL,
            "lease_until" = NULL,
            "available_at" = transaction_timestamp() + make_interval(secs => ${backoffSeconds})
        WHERE "id" = ${eventResult.outboxEventId}::uuid
          AND "lease_token" = ${eventResult.leaseToken}::uuid
        RETURNING "id"
      `);
      return result;
    });

    if ((rows as unknown as Array<{ id: string }>).length > 0) {
      rescheduledCount++;
    }
  }

  return rescheduledCount;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Traite un batch d'événements BOOKING_CONFIRMED.v1 à travers les phases A, B, C.
 *
 * @param db Client base de données.
 * @param renderer Moteur de rendu de documents.
 * @param storage Stockage objet.
 * @param batchLimit Nombre maximum d'événements à traiter (défaut 10).
 * @returns Résultat agrégé du pipeline.
 */
/**
 * Options du pipeline de génération de documents.
 *
 * `onAfterPhaseB` est un seam de test exécuté après Phase B (render + store)
 * et avant Phase C (persistance). Il permet de simuler un crash entre le
 * stockage objet et la persistance DB. En production, ce hook n'est pas utilisé.
 */
export interface DocumentPipelineOptions {
  /** Hook optionnel exécuté après Phase B, avant Phase C. Tests de crash/replay. */
  readonly onAfterPhaseB?: () => Promise<void> | void;
}

export async function executeDocumentPipeline(
  db: DatabaseClient,
  renderer: DocumentRenderer,
  storage: ObjectStorage,
  batchLimit?: number,
  options?: DocumentPipelineOptions,
): Promise<DocumentPipelineResult> {
  const limit = validateBatchLimit(batchLimit);

  // Phase A — claim + init effects + snapshot + reserve storage keys.
  const {
    results: phaseAResults,
    totalClaimed,
    malformedCount,
  } = await phaseAClaimAndInit(db, limit);

  if (totalClaimed === 0) {
    return {
      claimedCount: 0,
      completedCount: 0,
      failedCount: 0,
      rescheduledCount: 0,
      leaseLostCount: 0,
      anomalies: [],
    };
  }

  // Phase B — render + store (hors transaction).
  const phaseBResults = await phaseBRenderAndStore(db, renderer, storage, phaseAResults);

  // Seam de test : simuler un crash après Phase B avant Phase C.
  if (options?.onAfterPhaseB) {
    await options.onAfterPhaseB();
  }

  // Phase C — persist results (transaction courte).
  const { completedCount, failedCount, leaseLostCount, anomalies } = await phaseCPersist(
    db,
    phaseBResults,
    phaseAResults,
  );

  // Reschedule transient errors.
  const rescheduledCount = await rescheduleTransientErrors(db, phaseBResults);

  return {
    claimedCount: totalClaimed,
    completedCount,
    failedCount: failedCount + malformedCount,
    rescheduledCount,
    leaseLostCount,
    anomalies,
  };
}
