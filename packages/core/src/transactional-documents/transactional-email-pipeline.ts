/**
 * @uttily/core — Pipeline d'envoi d'emails transactionnels idempotent (G5E Round 2, ADR-013 §11).
 *
 * Orchestrateur en trois phases pour les événements BOOKING_CONFIRMED.v1 dont
 * les 3 effets GENERATE_* sont COMPLETED et l'effet SEND_EMAIL est PENDING.
 *
 * Phase A — transaction PostgreSQL courte :
 * 1. Claim batch (claimOutboxBatch, eligibility='READY_FOR_TRANSACTIONAL_EMAIL',
 *    incrementStrategy='always' per ADR-013 §7).
 * 2. Pour chaque événement claimé :
 *    a. Lock outbox_event (SELECT FOR UPDATE) avec organization_id + lease_token.
 *    b. Lock outbox_effects (SELECT FOR UPDATE) en ordre.
 *    c. Relire les 4 effets, validateEffectSet.
 *    d. Vérifier 3 GENERATE_* COMPLETED + SEND_EMAIL PENDING.
 *    e. Trouver l'effet SEND_EMAIL → son ID.
 *    f. Vérifier si notification_deliveries existe déjà pour cet outbox_effect_id.
 *       - Si existe + SENT → réconciliation en Phase C (ne PAS skip).
 *       - Si existe + PENDING → valider recipient_email avec parseRecipientEmail,
 *         réutiliser recipient_email (NE PAS relire users.email).
 *       - Si incohérent → fail-closed (outbox FAILED + SEND_EMAIL FAILED, clean lease).
 *       - Si n'existe pas → lire users.email AVEC filtre organization_id sur le booking,
 *         valider/normaliser avec parseRecipientEmail, dériver les clés d'idempotence,
 *         INSERT notification_deliveries (ON CONFLICT DO NOTHING).
 *    g. Retourner un PhaseAResult structuré.
 * 3. COMMIT.
 *
 * Phase B — hors transaction (aucun verrou DB) :
 * Pour chaque événement :
 * 1. Réserver/incrémenter le attempt_count du SEND_EMAIL effect (short fenced tx).
 *    Si lease perdue → LEASE_LOST, skip.
 * 2. Appeler sender.send() HORS transaction.
 *    Variables minimales sans PII : { bookingId: aggregateId }.
 *    template_key = BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY.
 * 3. Normaliser le résultat en SendOutcome (type fermé, aucun raw Error).
 *
 * Phase C — transaction PostgreSQL courte (réconciliation autoritaire) :
 * 1. Fencing : SELECT FOR UPDATE avec lease_token + lease_until > now() + organization_id.
 *    Si lease perdue → LEASE_LOST, ne pas persister.
 * 2. Lock outbox_effects (FOR UPDATE) en ordre.
 * 3. Lock notification_deliveries (FOR UPDATE) avec organization_id.
 * 4. Relire les 4 effets, validateEffectSet.
 * 5. Réconciliation autoritaire (SEND_EMAIL status × notification status) :
 *    Voir le tableau de réconciliation dans la documentation du code.
 * 6. Pour TOUTES les branches non LEASE_LOST :
 *    - outbox → PROCESSED (lease nettoyé) OU FAILED (lease nettoyé) OU PENDING+backoff (lease nettoyé).
 *    - JAMAIS PROCESSING avec un lease actif après un retour contrôlé.
 *
 * Compteurs post-commit :
 * - Chaque transaction Phase A et Phase C RETOURNE un résultat structuré.
 * - L'orchestrateur agrège les compteurs APRÈS la résolution des transactions.
 * - Si un commit échoue, aucun compteur n'est incrémenté.
 *
 * Confidentialité :
 * - Aucun PII (email, nom, adresse) dans les messages d'erreur.
 * - Les clés d'idempotence ne contiennent aucun PII.
 * - recipient_email est figé au moment de la création de notification_deliveries
 *   et n'est JAMAIS relu depuis users.email lors des retries.
 * - Aucun raw Error du fournisseur n'est stocké, retourné, persisté ou logué.
 */

import { sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import type { TransactionalEmailSender } from './ports';
import type { EmailSendResult } from './types';
import type { OutboxEffectType } from './types';
import type { EffectValidationRow } from './effect-validation';
import { validateEffectSet } from './effect-validation';
import {
  BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY,
  emailProviderIdempotencyKey,
  emailDeliveryIdempotencyKey,
} from './email-idempotency-keys';
import { parseRecipientEmail } from './recipient-email';
import { validateEmailResult } from './email-result-validation';
import { failClosedInTransaction, FencingFailureError } from './fail-closed-in-transaction';
import {
  claimOutboxBatch,
  validateBatchLimit,
  getBackoffIntervalSeconds,
  BOOKING_CONFIRMED_SELECTION,
} from '../outbox-claim';
import { MAX_ATTEMPTS } from '../outbox-claim/scheduling';
import type { ClaimEligibility } from '../outbox-claim';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TransactionalEmailPipelineResult {
  readonly claimedCount: number;
  readonly sentCount: number;
  readonly failedCount: number;
  readonly manualReviewCount: number;
  readonly leaseLostCount: number;
  readonly anomalies: Array<{
    readonly outboxEventId: string;
    readonly failureCode: string;
  }>;
}

/** Résultat structuré de Phase A pour un événement. */
type PhaseAResult =
  | {
      kind: 'READY';
      outboxEventId: string;
      organizationId: string;
      aggregateId: string;
      leaseToken: string;
      attemptCount: number;
      sendEmailEffectId: string;
      recipientEmail: string;
      providerIdempotencyKey: string;
      idempotencyKey: string;
      notificationId: string | null;
      notificationStatus: 'PENDING' | 'SENT' | 'FAILED' | 'REQUIRES_MANUAL_REVIEW';
    }
  | { kind: 'FAIL_CLOSED'; outboxEventId: string; failureCode: string };

/** Résultat de Phase A agrégé. */
interface PhaseAAggregate {
  results: PhaseAResult[];
  totalClaimed: number;
  phaseAFailures: Array<{ outboxEventId: string; failureCode: string }>;
}

/** Outcome d'envoi normalisé (type fermé, aucun raw Error). */
type SendOutcome =
  | EmailSendResult
  | { kind: 'LEASE_LOST' }
  | { kind: 'NOT_PENDING' }
  | { kind: 'RECONCILE_REQUIRED' }
  | { kind: 'CUTOFF_MANUAL_REVIEW' }
  | { kind: 'BUDGET_EXHAUSTED' };

/** Données de Phase B pour un événement. */
interface PhaseBResult {
  outboxEventId: string;
  organizationId: string;
  aggregateId: string;
  leaseToken: string;
  /** SEND_EMAIL effect attempt_count after Phase B increment (for budget decisions). */
  attemptCount: number;
  /** Outbox event's attempt_count from claim (for telemetry only). */
  outboxAttemptCount: number;
  sendEmailEffectId: string;
  recipientEmail: string;
  providerIdempotencyKey: string;
  idempotencyKey: string;
  notificationId: string | null;
  /** First provider attempt timestamp (read from DB, needed for cutoff age). */
  providerFirstAttemptStartedAt: Date | null;
  sendOutcome: SendOutcome;
}

/** Résultat structuré de Phase C pour un événement. */
type PhaseCEventResult =
  | { kind: 'SENT'; outboxEventId: string }
  | { kind: 'FAILED'; outboxEventId: string; failureCode: string }
  | { kind: 'LEASE_LOST'; outboxEventId: string }
  | { kind: 'TRANSIENT_RETRY'; outboxEventId: string }
  | { kind: 'RECONCILED_NOOP'; outboxEventId: string }
  | { kind: 'MANUAL_REVIEW'; outboxEventId: string }
  | { kind: 'BUDGET_EXHAUSTED'; outboxEventId: string };

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — mappage des lignes DB
// ─────────────────────────────────────────────────────────────────────────────

interface EffectRow {
  id: string;
  effectType: OutboxEffectType;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  documentId: string | null;
  storageKey: string | null;
  idempotencyKey: string;
  attemptCount: number;
}

function mapEffectRows(
  rows: Array<{
    id: string;
    effect_type: OutboxEffectType;
    status: 'PENDING' | 'COMPLETED' | 'FAILED';
    document_id: string | null;
    storage_key: string | null;
    idempotency_key: string;
    attempt_count: number;
  }>,
): EffectRow[] {
  return rows.map((r) => ({
    id: r.id,
    effectType: r.effect_type,
    status: r.status,
    documentId: r.document_id,
    storageKey: r.storage_key,
    idempotencyKey: r.idempotency_key,
    attemptCount: r.attempt_count,
  }));
}

function toValidationRows(effects: EffectRow[]): EffectValidationRow[] {
  return effects.map((e) => ({
    effectType: e.effectType,
    status: e.status,
    documentId: e.documentId,
    storageKey: e.storageKey,
    idempotencyKey: e.idempotencyKey,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase A — transaction courte (claim + init notification_deliveries)
// ─────────────────────────────────────────────────────────────────────────────

async function phaseAClaimAndInit(
  db: DatabaseClient,
  batchLimit: number,
): Promise<PhaseAAggregate> {
  return await db.transaction(async (tx) => {
    const claimed = await claimOutboxBatch(
      tx,
      BOOKING_CONFIRMED_SELECTION,
      batchLimit,
      'always',
      'READY_FOR_TRANSACTIONAL_EMAIL' as ClaimEligibility,
    );

    if (claimed.length === 0) {
      return { results: [], totalClaimed: 0, phaseAFailures: [] };
    }

    const results: PhaseAResult[] = [];
    const phaseAFailures: Array<{ outboxEventId: string; failureCode: string }> = [];

    for (const event of claimed) {
      let phaseAResult: PhaseAResult | null = null;
      let eventFailed = false;
      let failCode = 'UNKNOWN_ERROR';
      let capturedSendEmailEffectId: string | null = null;

      try {
        phaseAResult = await tx.transaction(async (sp) => {
          // a. Lock outbox_event (SELECT FOR UPDATE) avec organization_id + lease_token
          //    + lease_until > now() (REQ 7). Vérifier exactement 1 ligne ; si 0 lignes
          //    → lease perdue → RECONCILE_PRECONDITION_VIOLATED (rollback savepoint).
          const lockRows = await sp.execute(sql`
            SELECT "id" FROM "outbox_events"
            WHERE "id" = ${event.outboxEventId}::uuid
              AND "organization_id" = ${event.organizationId}::uuid
              AND "lease_token" = ${event.leaseToken}::uuid
              AND "lease_until" > transaction_timestamp()
            FOR UPDATE
          `);
          if ((lockRows as unknown as Array<{ id: string }>).length !== 1) {
            throw new FencingFailureError();
          }

          // b. Lock outbox_effects (SELECT FOR UPDATE) en ordre.
          const effectRows = await sp.execute(sql`
            SELECT "id", "effect_type", "status", "document_id", "storage_key",
                   "idempotency_key", "attempt_count"
            FROM "outbox_effects"
            WHERE "outbox_event_id" = ${event.outboxEventId}::uuid
              AND "organization_id" = ${event.organizationId}::uuid
            ORDER BY "effect_type" ASC
            FOR UPDATE
          `);
          const effects = mapEffectRows(
            effectRows as unknown as Array<{
              id: string;
              effect_type: OutboxEffectType;
              status: 'PENDING' | 'COMPLETED' | 'FAILED';
              document_id: string | null;
              storage_key: string | null;
              idempotency_key: string;
              attempt_count: number;
            }>,
          );

          // c+d. Valider les invariants et vérifier les préconditions.
          validateEffectSet({
            effects: toValidationRows(effects),
            outboxEventId: event.outboxEventId,
          });

          // Vérifier 3 GENERATE_* COMPLETED.
          const generateCompleted = effects.filter(
            (e) =>
              (e.effectType === 'GENERATE_CONFIRMATION' ||
                e.effectType === 'GENERATE_CONTRACT' ||
                e.effectType === 'GENERATE_RECEIPT') &&
              e.status === 'COMPLETED',
          ).length;
          if (generateCompleted !== 3) {
            throw new Error('EFFECT_SET_INVARIANT_VIOLATED');
          }

          // Vérifier SEND_EMAIL PENDING.
          const sendEmailEffect = effects.find((e) => e.effectType === 'SEND_EMAIL');
          if (!sendEmailEffect || sendEmailEffect.status !== 'PENDING') {
            throw new Error('EFFECT_SET_INVARIANT_VIOLATED');
          }

          const sendEmailEffectId = sendEmailEffect.id;
          capturedSendEmailEffectId = sendEmailEffectId;

          // Dériver les clés d'idempotence.
          const providerIdempotencyKey = emailProviderIdempotencyKey(event.outboxEventId);
          const idempotencyKey = emailDeliveryIdempotencyKey(event.outboxEventId);

          // f. Vérifier si notification_deliveries existe déjà.
          const existingNotifRows = await sp.execute(sql`
            SELECT "id", "status", "recipient_email", "template_key",
                   "provider_idempotency_key", "idempotency_key", "organization_id",
                   "outbox_event_id", "outbox_effect_id"
            FROM "notification_deliveries"
            WHERE "outbox_effect_id" = ${sendEmailEffectId}::uuid
              AND "organization_id" = ${event.organizationId}::uuid
            FOR UPDATE
          `);
          const existingNotif = (
            existingNotifRows as unknown as Array<{
              id: string;
              status: 'PENDING' | 'SENT' | 'FAILED' | 'REQUIRES_MANUAL_REVIEW';
              recipient_email: string;
              template_key: string;
              provider_idempotency_key: string;
              idempotency_key: string;
              organization_id: string;
              outbox_event_id: string;
              outbox_effect_id: string;
            }>
          )[0];

          if (existingNotif) {
            // Valider la cohérence stricte.
            if (
              existingNotif.organization_id !== event.organizationId ||
              existingNotif.outbox_event_id !== event.outboxEventId ||
              existingNotif.outbox_effect_id !== sendEmailEffectId ||
              existingNotif.template_key !== BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY ||
              existingNotif.provider_idempotency_key !== providerIdempotencyKey ||
              existingNotif.idempotency_key !== idempotencyKey
            ) {
              // Incohérent → fail-closed.
              throw new Error('NOTIFICATION_INCOHERENT');
            }

            // Cohérent — valider recipient_email avec le parseur strict.
            if (existingNotif.status === 'PENDING') {
              try {
                parseRecipientEmail(existingNotif.recipient_email);
              } catch {
                throw new Error('RECIPIENT_EMAIL_INVALID');
              }
            }

            // Retourner le résultat READY (ne PAS skip même si SENT — la réconciliation
            // se fait en Phase C).
            return {
              kind: 'READY' as const,
              outboxEventId: event.outboxEventId,
              organizationId: event.organizationId,
              aggregateId: event.aggregateId,
              leaseToken: event.leaseToken,
              attemptCount: event.attemptCount,
              sendEmailEffectId,
              recipientEmail: existingNotif.recipient_email,
              providerIdempotencyKey,
              idempotencyKey,
              notificationId: existingNotif.id,
              notificationStatus: existingNotif.status,
            };
          }

          // g. notification_deliveries n'existe pas → PREMIÈRE création.
          // Lire users.email via booking.customer_user_id AVEC filtre organization_id.
          const emailRows = await sp.execute(sql`
            SELECT u."email" FROM "users" u
            JOIN "bookings" b ON b."customer_user_id" = u."id"
            WHERE b."id" = ${event.aggregateId}::uuid
              AND b."organization_id" = ${event.organizationId}::uuid
          `);
          const emailRow = (emailRows as unknown as Array<{ email: string }>)[0];
          if (!emailRow || !emailRow.email) {
            throw new Error('RECIPIENT_EMAIL_INVALID');
          }

          // Valider/normaliser l'email avec le parseur strict.
          const recipientEmail = parseRecipientEmail(emailRow.email);

          // INSERT notification_deliveries avec ON CONFLICT (idempotency_key) DO NOTHING.
          const insertRows = await sp.execute(sql`
            INSERT INTO "notification_deliveries" (
              "organization_id", "outbox_event_id", "outbox_effect_id",
              "recipient_email", "template_key", "provider_idempotency_key",
              "status", "idempotency_key"
            ) VALUES (
              ${event.organizationId}::uuid,
              ${event.outboxEventId}::uuid,
              ${sendEmailEffectId}::uuid,
              ${recipientEmail},
              ${BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY},
              ${providerIdempotencyKey},
              'PENDING'::notification_delivery_status,
              ${idempotencyKey}
            )
            ON CONFLICT ("idempotency_key") DO NOTHING
            RETURNING "id", "status"
          `);
          const inserted = (
            insertRows as unknown as Array<{
              id: string;
              status: 'PENDING' | 'SENT' | 'FAILED' | 'REQUIRES_MANUAL_REVIEW';
            }>
          )[0];

          if (inserted) {
            return {
              kind: 'READY' as const,
              outboxEventId: event.outboxEventId,
              organizationId: event.organizationId,
              aggregateId: event.aggregateId,
              leaseToken: event.leaseToken,
              attemptCount: event.attemptCount,
              sendEmailEffectId,
              recipientEmail,
              providerIdempotencyKey,
              idempotencyKey,
              notificationId: inserted.id,
              notificationStatus: inserted.status,
            };
          }

          // Conflit sur idempotency_key → relire l'existant et valider la cohérence.
          const conflictRows = await sp.execute(sql`
            SELECT "id", "status", "recipient_email", "template_key",
                   "provider_idempotency_key", "idempotency_key", "organization_id",
                   "outbox_event_id", "outbox_effect_id"
            FROM "notification_deliveries"
            WHERE "idempotency_key" = ${idempotencyKey}
              AND "organization_id" = ${event.organizationId}::uuid
            FOR UPDATE
          `);
          const conflictNotif = (
            conflictRows as unknown as Array<{
              id: string;
              status: 'PENDING' | 'SENT' | 'FAILED' | 'REQUIRES_MANUAL_REVIEW';
              recipient_email: string;
              template_key: string;
              provider_idempotency_key: string;
              idempotency_key: string;
              organization_id: string;
              outbox_event_id: string;
              outbox_effect_id: string;
            }>
          )[0];

          if (!conflictNotif) {
            throw new Error('NOTIFICATION_INCOHERENT');
          }

          // Valider la cohérence stricte.
          if (
            conflictNotif.organization_id !== event.organizationId ||
            conflictNotif.outbox_event_id !== event.outboxEventId ||
            conflictNotif.outbox_effect_id !== sendEmailEffectId ||
            conflictNotif.template_key !== BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY ||
            conflictNotif.provider_idempotency_key !== providerIdempotencyKey ||
            conflictNotif.idempotency_key !== idempotencyKey
          ) {
            throw new Error('NOTIFICATION_INCOHERENT');
          }

          // Valider recipient_email si PENDING.
          if (conflictNotif.status === 'PENDING') {
            try {
              parseRecipientEmail(conflictNotif.recipient_email);
            } catch {
              throw new Error('RECIPIENT_EMAIL_INVALID');
            }
          }

          return {
            kind: 'READY' as const,
            outboxEventId: event.outboxEventId,
            organizationId: event.organizationId,
            aggregateId: event.aggregateId,
            leaseToken: event.leaseToken,
            attemptCount: event.attemptCount,
            sendEmailEffectId,
            recipientEmail: conflictNotif.recipient_email,
            providerIdempotencyKey,
            idempotencyKey,
            notificationId: conflictNotif.id,
            notificationStatus: conflictNotif.status,
          };
        });
      } catch (err) {
        // Fencing failure (lease expirée/perdue) → le savepoint a été annulé
        // automatiquement par le driver. NE PAS exécuter le fail-closed avec
        // l'ancien lease (l'événement reste PROCESSING avec son lease expiré ;
        // il sera reclamé par un autre worker). Continuer le batch.
        if (err instanceof FencingFailureError) {
          continue;
        }
        // Le savepoint a été annulé automatiquement par le driver.
        eventFailed = true;
        const errMsg = err instanceof Error ? err.message : 'UNKNOWN_ERROR';
        if (errMsg.startsWith('RECIPIENT_EMAIL_INVALID')) {
          failCode = 'RECIPIENT_EMAIL_INVALID';
        } else if (errMsg.startsWith('NOTIFICATION_INCOHERENT')) {
          failCode = 'NOTIFICATION_INCOHERENT';
        } else {
          failCode = 'EFFECT_SET_INVARIANT_VIOLATED';
        }
      }

      if (eventFailed) {
        // Fail-closed dans la transaction extérieure via le helper partagé.
        // Utiliser 'UNKNOWN_ERROR' dans la DB (seul code d'enum valide pour les
        // violations d'invariant). Le code spécifique est conservé dans phaseAFailures.
        //
        // Le fail-closed est enveloppé dans un savepoint afin qu'une levée
        // d'exception du helper (notamment RECONCILE_PRECONDITION_VIOLATED si le
        // lease a été volé concurrentement, ou toute future erreur SQL) n'aborde
        // pas la transaction extérieure. La transaction extérieure reste
        // utilisable pour l'événement suivant du même batch (requirement #11(n)).
        const dbFailureCode = 'UNKNOWN_ERROR';
        try {
          await tx.transaction(async (sp) => {
            // REQ 4: If capturedSendEmailEffectId is null (validateEffectSet failed
            // before the SEND_EMAIL effect was found), look up the SEND_EMAIL effect
            // under lock BEFORE calling the helper. This ensures a real PENDING
            // SEND_EMAIL effect is marked FAILED instead of being left PENDING.
            let effectIdForFailClosed = capturedSendEmailEffectId;
            if (!effectIdForFailClosed) {
              const found = await sp.execute(sql`
                SELECT "id" FROM "outbox_effects"
                WHERE "outbox_event_id" = ${event.outboxEventId}::uuid
                  AND "organization_id" = ${event.organizationId}::uuid
                  AND "effect_type" = 'SEND_EMAIL'
                FOR UPDATE
              `);
              effectIdForFailClosed = (found as unknown as Array<{ id: string }>)[0]?.id ?? null;
            }
            await failClosedInTransaction(
              sp,
              event.outboxEventId,
              event.organizationId,
              event.leaseToken,
              effectIdForFailClosed,
              dbFailureCode,
            );
          });
          phaseAFailures.push({ outboxEventId: event.outboxEventId, failureCode: failCode });
        } catch (err) {
          // RECONCILE_PRECONDITION_VIOLATED → le lease a été perdu concurrentement
          // (un autre worker a volé l'événement). Ne PAS compter comme échec ;
          // l'événement reste PROCESSING sous le nouveau propriétaire.
          // Le savepoint a été annulé ; la transaction extérieure est intacte.
          if (err instanceof Error && err.message === 'RECONCILE_PRECONDITION_VIOLATED') {
            continue;
          }
          throw err;
        }
        continue;
      }

      if (phaseAResult) {
        results.push(phaseAResult);
      }
    }

    return { results, totalClaimed: claimed.length, phaseAFailures };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase B — hors transaction (appel sender)
// ─────────────────────────────────────────────────────────────────────────────

const CUTOFF_SECONDS = 23 * 3600;

async function phaseBSendEmail(
  db: DatabaseClient,
  sender: TransactionalEmailSender,
  phaseAResults: PhaseAResult[],
): Promise<PhaseBResult[]> {
  const results: PhaseBResult[] = [];

  for (const event of phaseAResults) {
    if (event.kind !== 'READY') continue;

    // REQ 1: Never recall the provider if the notification is already terminal.
    // Phase A transports notificationStatus ('PENDING'|'SENT'|'FAILED'|'REQUIRES_MANUAL_REVIEW')
    // but the claim filter may have passed before the notification became terminal.
    // If SENT or FAILED → skip sender.send, push RECONCILE_REQUIRED for Phase C.
    // REQUIRES_MANUAL_REVIEW is handled by the fenced reservation (lease release).
    if (event.notificationStatus === 'SENT' || event.notificationStatus === 'FAILED') {
      results.push({
        outboxEventId: event.outboxEventId,
        organizationId: event.organizationId,
        aggregateId: event.aggregateId,
        leaseToken: event.leaseToken,
        attemptCount: event.attemptCount,
        outboxAttemptCount: event.attemptCount,
        sendEmailEffectId: event.sendEmailEffectId,
        recipientEmail: event.recipientEmail,
        providerIdempotencyKey: event.providerIdempotencyKey,
        idempotencyKey: event.idempotencyKey,
        notificationId: event.notificationId,
        providerFirstAttemptStartedAt: null,
        sendOutcome: { kind: 'RECONCILE_REQUIRED' },
      });
      continue;
    }

    try {
      // 1. Short fenced transaction: lock outbox → effect → notification,
      //    validate, check cutoff/budget, reserve attempt_count + timestamp.
      const reservation = await db.transaction(async (tx) => {
        // 1. lock outbox_event (fencing).
        const eventRows = (await tx.execute(sql`
        SELECT "id" FROM "outbox_events"
        WHERE "id" = ${event.outboxEventId}::uuid
          AND "organization_id" = ${event.organizationId}::uuid
          AND "lease_token" = ${event.leaseToken}::uuid
          AND "lease_until" > transaction_timestamp()
        FOR UPDATE
      `)) as unknown as Array<{ id: string }>;
        if (eventRows.length === 0) {
          return { reserved: false as const, reason: 'LEASE_LOST' as const };
        }

        // 2. lock SEND_EMAIL effect.
        const effectRows = (await tx.execute(sql`
        SELECT "id", "attempt_count" FROM "outbox_effects"
        WHERE "id" = ${event.sendEmailEffectId}::uuid
          AND "outbox_event_id" = ${event.outboxEventId}::uuid
          AND "organization_id" = ${event.organizationId}::uuid
          AND "effect_type" = 'SEND_EMAIL'
          AND "status" = 'PENDING'
        FOR UPDATE
      `)) as unknown as Array<{ id: string; attempt_count: number }>;
        const effectRow = effectRows[0];
        if (!effectRow) {
          return { reserved: false as const, reason: 'NOT_PENDING' as const };
        }

        // 3. lock notification_delivery.
        const notifRows = (await tx.execute(sql`
        SELECT "id", "status", "provider_first_attempt_started_at",
               EXTRACT(EPOCH FROM (transaction_timestamp() - "provider_first_attempt_started_at"))::int as age_seconds
        FROM "notification_deliveries"
        WHERE "outbox_effect_id" = ${event.sendEmailEffectId}::uuid
          AND "organization_id" = ${event.organizationId}::uuid
          AND "outbox_event_id" = ${event.outboxEventId}::uuid
        FOR UPDATE
      `)) as unknown as Array<{
          id: string;
          status: 'PENDING' | 'SENT' | 'FAILED' | 'REQUIRES_MANUAL_REVIEW';
          provider_first_attempt_started_at: Date | null;
          age_seconds: number | null;
        }>;
        const notif = notifRows[0];
        if (!notif) {
          return { reserved: false as const, reason: 'NOT_PENDING' as const };
        }

        // Defensive: a concurrent worker already moved the notification to manual review.
        // Do not call the provider; do not mutate the notification or the SEND_EMAIL effect.
        // Release the outbox lease and report a manual-review outcome.
        if (notif.status === 'REQUIRES_MANUAL_REVIEW') {
          const manualRows = (await tx.execute(sql`
          UPDATE "outbox_events"
          SET "status" = 'PENDING',
              "lease_token" = NULL,
              "lease_until" = NULL,
              "processed_at" = NULL
          WHERE "id" = ${event.outboxEventId}::uuid
            AND "organization_id" = ${event.organizationId}::uuid
            AND "lease_token" = ${event.leaseToken}::uuid
            AND "status" = 'PROCESSING'
          RETURNING "id"
        `)) as unknown as Array<{ id: string }>;
          if (manualRows.length !== 1) {
            throw new Error('MANUAL_REVIEW_LEASE_LOST');
          }
          return { reserved: false as const, reason: 'CUTOFF_MANUAL_REVIEW' as const };
        }

        if (notif.status !== 'PENDING') {
          return { reserved: false as const, reason: 'NOT_PENDING' as const };
        }

        // 4-6. predicates already validated by the SELECTs above.

        // 7. Age is computed by the SELECT using transaction_timestamp(); null means no cutoff.
        let providerFirstAttemptStartedAt: Date | null = notif.provider_first_attempt_started_at;

        // 8. 23h cutoff: do NOT call the provider, do NOT consume an attempt, mark manual review.
        if (notif.age_seconds !== null && notif.age_seconds >= CUTOFF_SECONDS) {
          const manualRows = (await tx.execute(sql`
          UPDATE "notification_deliveries"
          SET "status" = 'REQUIRES_MANUAL_REVIEW',
              "failure_code" = 'EMAIL_RETRY_WINDOW_EXPIRED'::document_processing_failure_code
          WHERE "id" = ${notif.id}::uuid
            AND "organization_id" = ${event.organizationId}::uuid
            AND "status" = 'PENDING'
          RETURNING "id"
        `)) as unknown as Array<{ id: string }>;
          if (manualRows.length !== 1) {
            throw new Error('CUTOFF_PRECONDITION_VIOLATED');
          }

          const outboxUpdated = (await tx.execute(sql`
          UPDATE "outbox_events"
          SET "status" = 'PENDING',
              "lease_token" = NULL,
              "lease_until" = NULL,
              "processed_at" = NULL
          WHERE "id" = ${event.outboxEventId}::uuid
            AND "organization_id" = ${event.organizationId}::uuid
            AND "lease_token" = ${event.leaseToken}::uuid
            AND "status" = 'PROCESSING'
          RETURNING "id"
        `)) as unknown as Array<{ id: string }>;
          if (outboxUpdated.length !== 1) {
            throw new Error('CUTOFF_LEASE_UPDATE_FAILED');
          }

          return { reserved: false as const, reason: 'CUTOFF_MANUAL_REVIEW' as const };
        }

        // 9. Budget exhausted before another call: do NOT consume an attempt.
        if (effectRow.attempt_count >= MAX_ATTEMPTS) {
          const outboxUpdated = (await tx.execute(sql`
          UPDATE "outbox_events"
          SET "status" = 'PENDING',
              "lease_token" = NULL,
              "lease_until" = NULL,
              "processed_at" = NULL
          WHERE "id" = ${event.outboxEventId}::uuid
            AND "organization_id" = ${event.organizationId}::uuid
            AND "lease_token" = ${event.leaseToken}::uuid
            AND "status" = 'PROCESSING'
          RETURNING "id"
        `)) as unknown as Array<{ id: string }>;
          if (outboxUpdated.length !== 1) {
            throw new Error('BUDGET_LEASE_UPDATE_FAILED');
          }
          return { reserved: false as const, reason: 'BUDGET_EXHAUSTED' as const };
        }

        // 10. Actual provider call: increment SEND_EMAIL attempt_count and set first-attempt timestamp only if unset.
        const updated = (await tx.execute(sql`
        UPDATE "outbox_effects"
        SET "attempt_count" = "attempt_count" + 1
        WHERE "id" = ${event.sendEmailEffectId}::uuid
          AND "organization_id" = ${event.organizationId}::uuid
          AND "outbox_event_id" = ${event.outboxEventId}::uuid
          AND "effect_type" = 'SEND_EMAIL'
          AND "status" = 'PENDING'
        RETURNING "attempt_count"
      `)) as unknown as Array<{ attempt_count: number }>;
        if (updated.length !== 1) {
          throw new Error('RESERVATION_ATTEMPT_COUNT_FAILED');
        }
        const effectAttemptCount = updated[0]!.attempt_count;

        // 11. Set first provider timestamp.
        if (providerFirstAttemptStartedAt === null) {
          const tsRows = (await tx.execute(sql`
          UPDATE "notification_deliveries"
          SET "provider_first_attempt_started_at" = transaction_timestamp()
          WHERE "id" = ${notif.id}::uuid
            AND "organization_id" = ${event.organizationId}::uuid
            AND "outbox_event_id" = ${event.outboxEventId}::uuid
            AND "provider_first_attempt_started_at" IS NULL
            AND "status" = 'PENDING'
          RETURNING "provider_first_attempt_started_at"
        `)) as unknown as Array<{ provider_first_attempt_started_at: Date }>;
          if (tsRows.length !== 1) {
            throw new Error('TIMESTAMP_RESERVATION_FAILED');
          }
          providerFirstAttemptStartedAt = tsRows[0]!.provider_first_attempt_started_at;
        }

        if (providerFirstAttemptStartedAt === null) {
          throw new Error('INVARIANT: providerFirstAttemptStartedAt is null after reservation');
        }
        if (effectAttemptCount < 1 || effectAttemptCount > MAX_ATTEMPTS) {
          throw new Error('INVARIANT: attempt count out of bounds');
        }

        return {
          reserved: true as const,
          effectAttemptCount,
          providerFirstAttemptStartedAt,
        };
      });

      if (!reservation.reserved) {
        const common: Omit<PhaseBResult, 'sendOutcome'> = {
          outboxEventId: event.outboxEventId,
          organizationId: event.organizationId,
          aggregateId: event.aggregateId,
          leaseToken: event.leaseToken,
          attemptCount: event.attemptCount,
          outboxAttemptCount: event.attemptCount,
          sendEmailEffectId: event.sendEmailEffectId,
          recipientEmail: event.recipientEmail,
          providerIdempotencyKey: event.providerIdempotencyKey,
          idempotencyKey: event.idempotencyKey,
          notificationId: event.notificationId,
          providerFirstAttemptStartedAt: null,
        };
        if (reservation.reason === 'LEASE_LOST') {
          results.push({ ...common, sendOutcome: { kind: 'LEASE_LOST' } });
        } else if (reservation.reason === 'CUTOFF_MANUAL_REVIEW') {
          results.push({ ...common, sendOutcome: { kind: 'CUTOFF_MANUAL_REVIEW' } });
        } else if (reservation.reason === 'BUDGET_EXHAUSTED') {
          results.push({ ...common, sendOutcome: { kind: 'BUDGET_EXHAUSTED' } });
        } else {
          results.push({ ...common, sendOutcome: { kind: 'NOT_PENDING' } });
        }
        continue;
      }

      // 2. Call sender.send() OUTSIDE any transaction.
      let rawResult: EmailSendResult;
      try {
        rawResult = await sender.send({
          recipientEmail: event.recipientEmail,
          templateKey: BOOKING_CONFIRMED_EMAIL_TEMPLATE_KEY,
          providerIdempotencyKey: event.providerIdempotencyKey,
          variables: { bookingId: event.aggregateId },
        });
      } catch {
        // Any exception (Error or non-Error) becomes UNCERTAIN.
        rawResult = { kind: 'UNCERTAIN', failureCode: 'UNKNOWN_FAILURE_AFTER_CALL_START' };
      }

      let sendOutcome: SendOutcome;
      try {
        const validated = validateEmailResult(rawResult);
        sendOutcome = validated.result;
      } catch {
        // Forged/incoherent runtime result becomes UNCERTAIN.
        sendOutcome = { kind: 'UNCERTAIN', failureCode: 'UNKNOWN_FAILURE_AFTER_CALL_START' };
      }

      results.push({
        outboxEventId: event.outboxEventId,
        organizationId: event.organizationId,
        aggregateId: event.aggregateId,
        leaseToken: event.leaseToken,
        attemptCount: reservation.effectAttemptCount,
        outboxAttemptCount: event.attemptCount,
        sendEmailEffectId: event.sendEmailEffectId,
        recipientEmail: event.recipientEmail,
        providerIdempotencyKey: event.providerIdempotencyKey,
        idempotencyKey: event.idempotencyKey,
        notificationId: event.notificationId,
        providerFirstAttemptStartedAt: reservation.providerFirstAttemptStartedAt,
        sendOutcome,
      });
    } catch {
      // Reservation transaction rolled back (invariant violation, trigger, etc.).
      // Release the outbox lease so the event becomes reclaimable; no provider call was made.
      const cleanupRows = (await db.execute(sql`
        UPDATE "outbox_events"
        SET "status" = 'PENDING',
            "lease_token" = NULL,
            "lease_until" = NULL,
            "processed_at" = NULL
        WHERE "id" = ${event.outboxEventId}::uuid
          AND "organization_id" = ${event.organizationId}::uuid
          AND "lease_token" = ${event.leaseToken}::uuid
        RETURNING "id"
      `)) as unknown as Array<{ id: string }>;
      if (cleanupRows.length !== 1) {
        throw new Error('LEASE_CLEANUP_PRECONDITION_VIOLATED');
      }
      continue;
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase C — transaction courte (persistance + réconciliation autoritaire)
// ─────────────────────────────────────────────────────────────────────────────

async function phaseCPersist(
  db: DatabaseClient,
  phaseBResults: PhaseBResult[],
): Promise<PhaseCEventResult[]> {
  const cResults: PhaseCEventResult[] = [];

  for (const event of phaseBResults) {
    // Skip lease-lost events (aucune persistance possible).
    if (event.sendOutcome.kind === 'LEASE_LOST') {
      cResults.push({ kind: 'LEASE_LOST', outboxEventId: event.outboxEventId });
      continue;
    }

    // Cutoff and budget outcomes were already persisted by the Phase B
    // reservation transaction; no Phase C work is needed.
    if (event.sendOutcome.kind === 'CUTOFF_MANUAL_REVIEW') {
      cResults.push({ kind: 'MANUAL_REVIEW', outboxEventId: event.outboxEventId });
      continue;
    }
    if (event.sendOutcome.kind === 'BUDGET_EXHAUSTED') {
      cResults.push({ kind: 'BUDGET_EXHAUSTED', outboxEventId: event.outboxEventId });
      continue;
    }

    let txResult: PhaseCEventResult;
    try {
      txResult = await db.transaction(async (tx): Promise<PhaseCEventResult> => {
        // 1. Fencing : SELECT FOR UPDATE avec lease_token + lease_until > now() + organization_id.
        const fenceRows = await tx.execute(sql`
        SELECT "id" FROM "outbox_events"
        WHERE "id" = ${event.outboxEventId}::uuid
          AND "organization_id" = ${event.organizationId}::uuid
          AND "lease_token" = ${event.leaseToken}::uuid
          AND "lease_until" > transaction_timestamp()
        FOR UPDATE
      `);
        if ((fenceRows as unknown as Array<{ id: string }>).length === 0) {
          return { kind: 'LEASE_LOST', outboxEventId: event.outboxEventId };
        }

        // 2. Lock outbox_effects (FOR UPDATE) en ordre.
        const effectRows = await tx.execute(sql`
        SELECT "id", "effect_type", "status", "document_id", "storage_key",
               "idempotency_key", "attempt_count"
        FROM "outbox_effects"
        WHERE "outbox_event_id" = ${event.outboxEventId}::uuid
          AND "organization_id" = ${event.organizationId}::uuid
        ORDER BY "effect_type" ASC
        FOR UPDATE
      `);
        const effects = mapEffectRows(
          effectRows as unknown as Array<{
            id: string;
            effect_type: OutboxEffectType;
            status: 'PENDING' | 'COMPLETED' | 'FAILED';
            document_id: string | null;
            storage_key: string | null;
            idempotency_key: string;
            attempt_count: number;
          }>,
        );

        // 4. Relire les 4 effets, validateEffectSet.
        try {
          validateEffectSet({
            effects: toValidationRows(effects),
            outboxEventId: event.outboxEventId,
          });
        } catch {
          // Invariant violation → fail closed.
          await failClosedInTransaction(
            tx,
            event.outboxEventId,
            event.organizationId,
            event.leaseToken,
            event.sendEmailEffectId,
            'UNKNOWN_ERROR',
          );
          return {
            kind: 'FAILED',
            outboxEventId: event.outboxEventId,
            failureCode: 'EFFECT_SET_INVARIANT_VIOLATED',
          };
        }

        const sendEmailEffect = effects.find((e) => e.effectType === 'SEND_EMAIL');
        if (!sendEmailEffect) {
          // Impossible si validateEffectSet a passé, mais défensif.
          await failClosedInTransaction(
            tx,
            event.outboxEventId,
            event.organizationId,
            event.leaseToken,
            null,
            'UNKNOWN_ERROR',
          );
          return {
            kind: 'FAILED',
            outboxEventId: event.outboxEventId,
            failureCode: 'EFFECT_SET_INVARIANT_VIOLATED',
          };
        }

        const sendEmailStatus = sendEmailEffect.status;

        // 3. Lock notification_deliveries (FOR UPDATE) avec organization_id.
        const notifRows = await tx.execute(sql`
        SELECT "id", "status", "provider_message_id", "failure_code", "sent_at",
               "provider_first_attempt_started_at",
               EXTRACT(EPOCH FROM (transaction_timestamp() - "provider_first_attempt_started_at"))::int as age_seconds
        FROM "notification_deliveries"
        WHERE "outbox_effect_id" = ${event.sendEmailEffectId}::uuid
          AND "organization_id" = ${event.organizationId}::uuid
        FOR UPDATE
      `);
        const notif = (
          notifRows as unknown as Array<{
            id: string;
            status: 'PENDING' | 'SENT' | 'FAILED' | 'REQUIRES_MANUAL_REVIEW';
            provider_message_id: string | null;
            failure_code: string | null;
            sent_at: Date | null;
            provider_first_attempt_started_at: Date | null;
            age_seconds: number | null;
          }>
        )[0];

        // ─── Réconciliation autoritaire ───
        // Tableau : SEND_EMAIL status × notification status → action
        //
        // PENDING × PENDING + sendResult    → nominal: SENT + COMPLETED + maybe PROCESSED
        // PENDING × PENDING + sendError     → error: backoff or terminal FAILED
        // PENDING × SENT                    → reconcile: complete SEND_EMAIL, maybe PROCESSED
        // PENDING × FAILED                  → reconcile: fail SEND_EMAIL, outbox FAILED
        // PENDING × (missing)               → fail-closed: outbox FAILED + SEND_EMAIL FAILED
        // COMPLETED × SENT                  → reconcile: maybe PROCESSED (if 4 COMPLETED)
        // COMPLETED × (not SENT)            → fail-closed: invariant impossible
        // COMPLETED × (missing)             → fail-closed
        // FAILED × *                        → reconcile: outbox FAILED
        // (invalid effects)                 → fail-closed: outbox FAILED + SEND_EMAIL FAILED

        // FAILED × * → outbox FAILED (déjà terminal, juste nettoyer le lease).
        if (sendEmailStatus === 'FAILED') {
          const failedRows = await tx.execute(sql`
          UPDATE "outbox_events"
          SET "status" = 'FAILED',
              "lease_token" = NULL,
              "lease_until" = NULL,
              "processed_at" = NULL
          WHERE "id" = ${event.outboxEventId}::uuid
            AND "organization_id" = ${event.organizationId}::uuid
            AND "lease_token" = ${event.leaseToken}::uuid
          RETURNING "id"
        `);
          if ((failedRows as unknown as Array<{ id: string }>).length !== 1) {
            throw new Error('RECONCILE_PRECONDITION_VIOLATED');
          }
          return {
            kind: 'FAILED',
            outboxEventId: event.outboxEventId,
            failureCode: 'EMAIL_SEND_FAILED',
          };
        }

        // COMPLETED × * → vérifier la notification et finaliser si possible.
        if (sendEmailStatus === 'COMPLETED') {
          if (!notif || notif.status !== 'SENT') {
            // COMPLETED × (not SENT ou missing) → fail-closed.
            await failClosedInTransaction(
              tx,
              event.outboxEventId,
              event.organizationId,
              event.leaseToken,
              event.sendEmailEffectId,
              'UNKNOWN_ERROR',
            );
            return {
              kind: 'FAILED',
              outboxEventId: event.outboxEventId,
              failureCode: 'EFFECT_SET_INVARIANT_VIOLATED',
            };
          }

          // COMPLETED × SENT → vérifier si tous les effets sont COMPLETED.
          const allEffectsRows = await tx.execute(sql`
          SELECT "id", "effect_type", "status", "document_id", "storage_key", "idempotency_key"
          FROM "outbox_effects"
          WHERE "outbox_event_id" = ${event.outboxEventId}::uuid
            AND "organization_id" = ${event.organizationId}::uuid
          ORDER BY "effect_type" ASC
          FOR UPDATE
        `);
          const allEffects = (
            allEffectsRows as unknown as Array<{
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

          try {
            validateEffectSet({
              effects: allEffects.map((e) => ({
                effectType: e.effectType,
                status: e.status,
                documentId: e.documentId,
                storageKey: e.storageKey,
                idempotencyKey: e.idempotencyKey,
              })),
              outboxEventId: event.outboxEventId,
            });
          } catch {
            await failClosedInTransaction(
              tx,
              event.outboxEventId,
              event.organizationId,
              event.leaseToken,
              event.sendEmailEffectId,
              'UNKNOWN_ERROR',
            );
            return {
              kind: 'FAILED',
              outboxEventId: event.outboxEventId,
              failureCode: 'EFFECT_SET_INVARIANT_VIOLATED',
            };
          }

          const allCompleted =
            allEffects.length === 4 && allEffects.every((e) => e.status === 'COMPLETED');

          if (allCompleted) {
            // Vérifier que la notification est bien SENT et liée au bon effect.
            const notifCheck = await tx.execute(sql`
            SELECT "status" FROM "notification_deliveries"
            WHERE "outbox_effect_id" = ${event.sendEmailEffectId}::uuid
              AND "organization_id" = ${event.organizationId}::uuid
              AND "status" = 'SENT'
          `);
            if ((notifCheck as unknown as Array<{ status: string }>).length !== 1) {
              await failClosedInTransaction(
                tx,
                event.outboxEventId,
                event.organizationId,
                event.leaseToken,
                event.sendEmailEffectId,
                'UNKNOWN_ERROR',
              );
              return {
                kind: 'FAILED',
                outboxEventId: event.outboxEventId,
                failureCode: 'EFFECT_SET_INVARIANT_VIOLATED',
              };
            }

            // Finalize: outbox → PROCESSED.
            const finalizeRows = await tx.execute(sql`
            UPDATE "outbox_events"
            SET "status" = 'PROCESSED',
                "processed_at" = transaction_timestamp(),
                "lease_token" = NULL,
                "lease_until" = NULL
            WHERE "id" = ${event.outboxEventId}::uuid
              AND "organization_id" = ${event.organizationId}::uuid
              AND "lease_token" = ${event.leaseToken}::uuid
            RETURNING "id"
          `);
            if ((finalizeRows as unknown as Array<{ id: string }>).length !== 1) {
              throw new Error('FINALIZATION_ATOMICITY_VIOLATED');
            }
            return { kind: 'RECONCILED_NOOP', outboxEventId: event.outboxEventId };
          }

          // REQ 6: Pas tous COMPLETED → outbox FAILED (invariant permanent).
          // Un outbox PENDING avec SEND_EMAIL COMPLETED est non-claimable par G5D
          // (besoin GENERATE_* PENDING) ni G5E (besoin SEND_EMAIL PENDING) → stuck.
          const notAllCompletedRows = await tx.execute(sql`
          UPDATE "outbox_events"
          SET "status" = 'FAILED',
              "lease_token" = NULL,
              "lease_until" = NULL,
              "processed_at" = NULL
          WHERE "id" = ${event.outboxEventId}::uuid
            AND "organization_id" = ${event.organizationId}::uuid
            AND "lease_token" = ${event.leaseToken}::uuid
          RETURNING "id"
        `);
          if ((notAllCompletedRows as unknown as Array<{ id: string }>).length !== 1) {
            throw new Error('RECONCILE_PRECONDITION_VIOLATED');
          }
          return {
            kind: 'FAILED',
            outboxEventId: event.outboxEventId,
            failureCode: 'EFFECT_SET_INVARIANT_VIOLATED',
          };
        }

        // sendEmailStatus === 'PENDING' — réconciliation selon notification status.

        // PENDING × (missing) → fail-closed.
        if (!notif) {
          await failClosedInTransaction(
            tx,
            event.outboxEventId,
            event.organizationId,
            event.leaseToken,
            event.sendEmailEffectId,
            'UNKNOWN_ERROR',
          );
          return {
            kind: 'FAILED',
            outboxEventId: event.outboxEventId,
            failureCode: 'NOTIFICATION_MISSING',
          };
        }

        // PENDING × FAILED → fail SEND_EMAIL, outbox FAILED.
        if (notif.status === 'FAILED') {
          // SEND_EMAIL → FAILED.
          const updateEffectRows = await tx.execute(sql`
          UPDATE "outbox_effects"
          SET "status" = 'FAILED',
              "completed_at" = transaction_timestamp(),
              "failure_code" = 'EMAIL_SEND_FAILED'::document_processing_failure_code
          WHERE "id" = ${event.sendEmailEffectId}::uuid
            AND "organization_id" = ${event.organizationId}::uuid
            AND "status" = 'PENDING'
          RETURNING "id"
        `);
          if ((updateEffectRows as unknown as Array<{ id: string }>).length !== 1) {
            throw new Error('ATOMICITY_VIOLATED: SEND_EMAIL UPDATE returned != 1 row');
          }

          // outbox → FAILED, lease nettoyé.
          const failedRows2 = await tx.execute(sql`
          UPDATE "outbox_events"
          SET "status" = 'FAILED',
              "lease_token" = NULL,
              "lease_until" = NULL,
              "processed_at" = NULL
          WHERE "id" = ${event.outboxEventId}::uuid
            AND "organization_id" = ${event.organizationId}::uuid
            AND "lease_token" = ${event.leaseToken}::uuid
          RETURNING "id"
        `);
          if ((failedRows2 as unknown as Array<{ id: string }>).length !== 1) {
            throw new Error('RECONCILE_PRECONDITION_VIOLATED');
          }
          return {
            kind: 'FAILED',
            outboxEventId: event.outboxEventId,
            failureCode: 'EMAIL_SEND_FAILED',
          };
        }

        // PENDING × SENT → reconcile: complete SEND_EMAIL, maybe PROCESSED.
        if (notif.status === 'SENT') {
          // SEND_EMAIL → COMPLETED.
          const updateEffectRows = await tx.execute(sql`
          UPDATE "outbox_effects"
          SET "status" = 'COMPLETED',
              "completed_at" = transaction_timestamp(),
              "failure_code" = NULL
          WHERE "id" = ${event.sendEmailEffectId}::uuid
            AND "organization_id" = ${event.organizationId}::uuid
            AND "status" = 'PENDING'
          RETURNING "id"
        `);
          if ((updateEffectRows as unknown as Array<{ id: string }>).length !== 1) {
            throw new Error('ATOMICITY_VIOLATED: SEND_EMAIL UPDATE returned != 1 row');
          }

          // Finalization re-validation.
          const allEffectsRows = await tx.execute(sql`
          SELECT "id", "effect_type", "status", "document_id", "storage_key", "idempotency_key"
          FROM "outbox_effects"
          WHERE "outbox_event_id" = ${event.outboxEventId}::uuid
            AND "organization_id" = ${event.organizationId}::uuid
          ORDER BY "effect_type" ASC
          FOR UPDATE
        `);
          const allEffects = (
            allEffectsRows as unknown as Array<{
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

          try {
            validateEffectSet({
              effects: allEffects.map((e) => ({
                effectType: e.effectType,
                status: e.status,
                documentId: e.documentId,
                storageKey: e.storageKey,
                idempotencyKey: e.idempotencyKey,
              })),
              outboxEventId: event.outboxEventId,
            });
          } catch {
            throw new Error('FINALIZATION_INVARIANT_VIOLATED');
          }

          const allCompleted =
            allEffects.length === 4 && allEffects.every((e) => e.status === 'COMPLETED');

          if (allCompleted) {
            // Vérifier que la notification est bien SENT et liée au bon effect.
            const notifCheck = await tx.execute(sql`
            SELECT "status" FROM "notification_deliveries"
            WHERE "outbox_effect_id" = ${event.sendEmailEffectId}::uuid
              AND "organization_id" = ${event.organizationId}::uuid
              AND "status" = 'SENT'
          `);
            if ((notifCheck as unknown as Array<{ status: string }>).length !== 1) {
              throw new Error('FINALIZATION_INVARIANT_VIOLATED');
            }

            // Finalize: outbox → PROCESSED.
            const finalizeRows = await tx.execute(sql`
            UPDATE "outbox_events"
            SET "status" = 'PROCESSED',
                "processed_at" = transaction_timestamp(),
                "lease_token" = NULL,
                "lease_until" = NULL
            WHERE "id" = ${event.outboxEventId}::uuid
              AND "organization_id" = ${event.organizationId}::uuid
              AND "lease_token" = ${event.leaseToken}::uuid
            RETURNING "id"
          `);
            if ((finalizeRows as unknown as Array<{ id: string }>).length !== 1) {
              throw new Error('FINALIZATION_ATOMICITY_VIOLATED');
            }
            return { kind: 'RECONCILED_NOOP', outboxEventId: event.outboxEventId };
          }

          // REQ 6: Pas tous COMPLETED → outbox FAILED (invariant permanent).
          // Un outbox PENDING avec SEND_EMAIL COMPLETED est non-claimable par G5D
          // (besoin GENERATE_* PENDING) ni G5E (besoin SEND_EMAIL PENDING) → stuck.
          const notAllCompletedRows2 = await tx.execute(sql`
          UPDATE "outbox_events"
          SET "status" = 'FAILED',
              "lease_token" = NULL,
              "lease_until" = NULL,
              "processed_at" = NULL
          WHERE "id" = ${event.outboxEventId}::uuid
            AND "organization_id" = ${event.organizationId}::uuid
            AND "lease_token" = ${event.leaseToken}::uuid
          RETURNING "id"
        `);
          if ((notAllCompletedRows2 as unknown as Array<{ id: string }>).length !== 1) {
            throw new Error('RECONCILE_PRECONDITION_VIOLATED');
          }
          return {
            kind: 'FAILED',
            outboxEventId: event.outboxEventId,
            failureCode: 'EFFECT_SET_INVARIANT_VIOLATED',
          };
        }

        // Pre-emptive branches for outcomes that did not call the provider.
        if (notif.status === 'REQUIRES_MANUAL_REVIEW') {
          return { kind: 'MANUAL_REVIEW', outboxEventId: event.outboxEventId };
        }
        if (event.sendOutcome.kind === 'BUDGET_EXHAUSTED') {
          return { kind: 'BUDGET_EXHAUSTED', outboxEventId: event.outboxEventId };
        }

        // PENDING × PENDING — dispatch on sendOutcome.

        if (event.sendOutcome.kind === 'DETERMINISTIC_REFUSAL') {
          // Refus terminal déterministe : l'email n'a PAS été envoyé.
          const updateNotifRows = await tx.execute(sql`
            UPDATE "notification_deliveries"
            SET "status" = 'FAILED',
                "failure_code" = 'EMAIL_SEND_FAILED'::document_processing_failure_code
            WHERE "id" = ${notif.id}::uuid
              AND "organization_id" = ${event.organizationId}::uuid
              AND "status" = 'PENDING'
            RETURNING "id"
          `);
          if ((updateNotifRows as unknown as Array<{ id: string }>).length !== 1) {
            throw new Error('ATOMICITY_VIOLATED: notification UPDATE returned != 1 row');
          }

          const updateEffectRows = await tx.execute(sql`
            UPDATE "outbox_effects"
            SET "status" = 'FAILED',
                "completed_at" = transaction_timestamp(),
                "failure_code" = 'EMAIL_SEND_FAILED'::document_processing_failure_code
            WHERE "id" = ${event.sendEmailEffectId}::uuid
              AND "organization_id" = ${event.organizationId}::uuid
              AND "status" = 'PENDING'
            RETURNING "id"
          `);
          if ((updateEffectRows as unknown as Array<{ id: string }>).length !== 1) {
            throw new Error('ATOMICITY_VIOLATED: SEND_EMAIL UPDATE returned != 1 row');
          }

          const terminalFailedRows = await tx.execute(sql`
            UPDATE "outbox_events"
            SET "status" = 'FAILED',
                "lease_token" = NULL,
                "lease_until" = NULL,
                "processed_at" = NULL
            WHERE "id" = ${event.outboxEventId}::uuid
              AND "organization_id" = ${event.organizationId}::uuid
              AND "lease_token" = ${event.leaseToken}::uuid
            RETURNING "id"
          `);
          if ((terminalFailedRows as unknown as Array<{ id: string }>).length !== 1) {
            throw new Error('RECONCILE_PRECONDITION_VIOLATED');
          }

          return {
            kind: 'FAILED',
            outboxEventId: event.outboxEventId,
            failureCode: 'EMAIL_SEND_FAILED',
          };
        }

        if (event.sendOutcome.kind === 'TRANSIENT_NOT_SENT') {
          // Refus temporaire certain : retry si âge < 23h et tentatives < MAX.

          if (notif.age_seconds !== null && notif.age_seconds >= CUTOFF_SECONDS) {
            const manualRows = await tx.execute(sql`
              UPDATE "notification_deliveries"
              SET "status" = 'REQUIRES_MANUAL_REVIEW',
                  "failure_code" = 'EMAIL_RETRY_WINDOW_EXPIRED'::document_processing_failure_code
              WHERE "id" = ${notif.id}::uuid
                AND "organization_id" = ${event.organizationId}::uuid
                AND "status" = 'PENDING'
              RETURNING "id"
            `);
            if ((manualRows as unknown as Array<{ id: string }>).length !== 1) {
              throw new Error('ATOMICITY_VIOLATED: notification UPDATE returned != 1 row');
            }

            const pendingRows = await tx.execute(sql`
              UPDATE "outbox_events"
              SET "status" = 'PENDING',
                  "lease_token" = NULL,
                  "lease_until" = NULL,
                  "processed_at" = NULL
              WHERE "id" = ${event.outboxEventId}::uuid
                AND "organization_id" = ${event.organizationId}::uuid
                AND "lease_token" = ${event.leaseToken}::uuid
              RETURNING "id"
            `);
            if ((pendingRows as unknown as Array<{ id: string }>).length !== 1) {
              throw new Error('RECONCILE_PRECONDITION_VIOLATED');
            }
            return { kind: 'MANUAL_REVIEW', outboxEventId: event.outboxEventId };
          }

          if (event.attemptCount >= MAX_ATTEMPTS) {
            const updateNotifRows = await tx.execute(sql`
              UPDATE "notification_deliveries"
              SET "status" = 'FAILED',
                  "failure_code" = 'EMAIL_SEND_FAILED'::document_processing_failure_code
              WHERE "id" = ${notif.id}::uuid
                AND "organization_id" = ${event.organizationId}::uuid
                AND "status" = 'PENDING'
              RETURNING "id"
            `);
            if ((updateNotifRows as unknown as Array<{ id: string }>).length !== 1) {
              throw new Error('ATOMICITY_VIOLATED: notification UPDATE returned != 1 row');
            }

            const updateEffectRows = await tx.execute(sql`
              UPDATE "outbox_effects"
              SET "status" = 'FAILED',
                  "completed_at" = transaction_timestamp(),
                  "failure_code" = 'EMAIL_SEND_FAILED'::document_processing_failure_code
              WHERE "id" = ${event.sendEmailEffectId}::uuid
                AND "organization_id" = ${event.organizationId}::uuid
                AND "status" = 'PENDING'
              RETURNING "id"
            `);
            if ((updateEffectRows as unknown as Array<{ id: string }>).length !== 1) {
              throw new Error('ATOMICITY_VIOLATED: SEND_EMAIL UPDATE returned != 1 row');
            }

            const terminalFailedRows = await tx.execute(sql`
              UPDATE "outbox_events"
              SET "status" = 'FAILED',
                  "lease_token" = NULL,
                  "lease_until" = NULL,
                  "processed_at" = NULL
              WHERE "id" = ${event.outboxEventId}::uuid
                AND "organization_id" = ${event.organizationId}::uuid
                AND "lease_token" = ${event.leaseToken}::uuid
              RETURNING "id"
            `);
            if ((terminalFailedRows as unknown as Array<{ id: string }>).length !== 1) {
              throw new Error('RECONCILE_PRECONDITION_VIOLATED');
            }

            return {
              kind: 'FAILED',
              outboxEventId: event.outboxEventId,
              failureCode: 'EMAIL_SEND_FAILED',
            };
          }

          // Retry with backoff.
          const backoffSeconds = getBackoffIntervalSeconds(Math.max(0, event.attemptCount - 1));
          const backoffRows = await tx.execute(sql`
            UPDATE "outbox_events"
            SET "status" = 'PENDING',
                "lease_token" = NULL,
                "lease_until" = NULL,
                "processed_at" = NULL,
                "available_at" = transaction_timestamp() + make_interval(secs => ${backoffSeconds})
            WHERE "id" = ${event.outboxEventId}::uuid
              AND "organization_id" = ${event.organizationId}::uuid
              AND "lease_token" = ${event.leaseToken}::uuid
            RETURNING "id"
          `);
          if ((backoffRows as unknown as Array<{ id: string }>).length !== 1) {
            throw new Error('RECONCILE_PRECONDITION_VIOLATED');
          }
          return { kind: 'TRANSIENT_RETRY', outboxEventId: event.outboxEventId };
        }

        if (event.sendOutcome.kind === 'UNCERTAIN') {
          // L'email a PU être envoyé : jamais FAILED. Retry, manuel si MAX ou cutoff.

          if (notif.age_seconds !== null && notif.age_seconds >= CUTOFF_SECONDS) {
            const manualRows = await tx.execute(sql`
              UPDATE "notification_deliveries"
              SET "status" = 'REQUIRES_MANUAL_REVIEW',
                  "failure_code" = 'EMAIL_RETRY_WINDOW_EXPIRED'::document_processing_failure_code
              WHERE "id" = ${notif.id}::uuid
                AND "organization_id" = ${event.organizationId}::uuid
                AND "status" = 'PENDING'
              RETURNING "id"
            `);
            if ((manualRows as unknown as Array<{ id: string }>).length !== 1) {
              throw new Error('ATOMICITY_VIOLATED: notification UPDATE returned != 1 row');
            }

            const pendingRows = await tx.execute(sql`
              UPDATE "outbox_events"
              SET "status" = 'PENDING',
                  "lease_token" = NULL,
                  "lease_until" = NULL,
                  "processed_at" = NULL
              WHERE "id" = ${event.outboxEventId}::uuid
                AND "organization_id" = ${event.organizationId}::uuid
                AND "lease_token" = ${event.leaseToken}::uuid
              RETURNING "id"
            `);
            if ((pendingRows as unknown as Array<{ id: string }>).length !== 1) {
              throw new Error('RECONCILE_PRECONDITION_VIOLATED');
            }
            return { kind: 'MANUAL_REVIEW', outboxEventId: event.outboxEventId };
          }

          if (event.attemptCount >= MAX_ATTEMPTS) {
            const manualRows = await tx.execute(sql`
              UPDATE "notification_deliveries"
              SET "status" = 'REQUIRES_MANUAL_REVIEW',
                  "failure_code" = 'PROVIDER_RESULT_UNCERTAIN'::document_processing_failure_code
              WHERE "id" = ${notif.id}::uuid
                AND "organization_id" = ${event.organizationId}::uuid
                AND "status" = 'PENDING'
              RETURNING "id"
            `);
            if ((manualRows as unknown as Array<{ id: string }>).length !== 1) {
              throw new Error('ATOMICITY_VIOLATED: notification UPDATE returned != 1 row');
            }

            const pendingRows = await tx.execute(sql`
              UPDATE "outbox_events"
              SET "status" = 'PENDING',
                  "lease_token" = NULL,
                  "lease_until" = NULL,
                  "processed_at" = NULL
              WHERE "id" = ${event.outboxEventId}::uuid
                AND "organization_id" = ${event.organizationId}::uuid
                AND "lease_token" = ${event.leaseToken}::uuid
              RETURNING "id"
            `);
            if ((pendingRows as unknown as Array<{ id: string }>).length !== 1) {
              throw new Error('RECONCILE_PRECONDITION_VIOLATED');
            }
            return { kind: 'MANUAL_REVIEW', outboxEventId: event.outboxEventId };
          }

          // Retry with backoff.
          const backoffSeconds = getBackoffIntervalSeconds(Math.max(0, event.attemptCount - 1));
          const backoffRows = await tx.execute(sql`
            UPDATE "outbox_events"
            SET "status" = 'PENDING',
                "lease_token" = NULL,
                "lease_until" = NULL,
                "processed_at" = NULL,
                "available_at" = transaction_timestamp() + make_interval(secs => ${backoffSeconds})
            WHERE "id" = ${event.outboxEventId}::uuid
              AND "organization_id" = ${event.organizationId}::uuid
              AND "lease_token" = ${event.leaseToken}::uuid
            RETURNING "id"
          `);
          if ((backoffRows as unknown as Array<{ id: string }>).length !== 1) {
            throw new Error('RECONCILE_PRECONDITION_VIOLATED');
          }
          return { kind: 'TRANSIENT_RETRY', outboxEventId: event.outboxEventId };
        }

        if (event.sendOutcome.kind === 'SENT') {
          // Succès — notification → SENT, SEND_EMAIL → COMPLETED.
          const updateNotifRows = await tx.execute(sql`
          UPDATE "notification_deliveries"
          SET "status" = 'SENT',
              "provider_message_id" = ${event.sendOutcome.providerMessageId},
              "sent_at" = transaction_timestamp(),
              "failure_code" = NULL
          WHERE "id" = ${notif.id}::uuid
            AND "organization_id" = ${event.organizationId}::uuid
            AND "status" = 'PENDING'
          RETURNING "id"
        `);
          if ((updateNotifRows as unknown as Array<{ id: string }>).length !== 1) {
            throw new Error('ATOMICITY_VIOLATED: notification UPDATE returned != 1 row');
          }

          const updateEffectRows = await tx.execute(sql`
          UPDATE "outbox_effects"
          SET "status" = 'COMPLETED',
              "completed_at" = transaction_timestamp(),
              "failure_code" = NULL
          WHERE "id" = ${event.sendEmailEffectId}::uuid
            AND "organization_id" = ${event.organizationId}::uuid
            AND "status" = 'PENDING'
          RETURNING "id"
        `);
          if ((updateEffectRows as unknown as Array<{ id: string }>).length !== 1) {
            throw new Error('ATOMICITY_VIOLATED: SEND_EMAIL UPDATE returned != 1 row');
          }

          // Finalization re-validation.
          const allEffectsRows = await tx.execute(sql`
          SELECT "id", "effect_type", "status", "document_id", "storage_key", "idempotency_key"
          FROM "outbox_effects"
          WHERE "outbox_event_id" = ${event.outboxEventId}::uuid
            AND "organization_id" = ${event.organizationId}::uuid
          ORDER BY "effect_type" ASC
          FOR UPDATE
        `);
          const allEffects = (
            allEffectsRows as unknown as Array<{
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

          try {
            validateEffectSet({
              effects: allEffects.map((e) => ({
                effectType: e.effectType,
                status: e.status,
                documentId: e.documentId,
                storageKey: e.storageKey,
                idempotencyKey: e.idempotencyKey,
              })),
              outboxEventId: event.outboxEventId,
            });
          } catch {
            throw new Error('FINALIZATION_INVARIANT_VIOLATED');
          }

          const allCompleted =
            allEffects.length === 4 && allEffects.every((e) => e.status === 'COMPLETED');

          if (allCompleted) {
            // Vérifier que la notification est bien SENT et liée au bon effect.
            const notifCheck = await tx.execute(sql`
            SELECT "status" FROM "notification_deliveries"
            WHERE "outbox_effect_id" = ${event.sendEmailEffectId}::uuid
              AND "organization_id" = ${event.organizationId}::uuid
              AND "status" = 'SENT'
          `);
            if ((notifCheck as unknown as Array<{ status: string }>).length !== 1) {
              throw new Error('FINALIZATION_INVARIANT_VIOLATED');
            }

            // Finalize: outbox → PROCESSED.
            const finalizeRows = await tx.execute(sql`
            UPDATE "outbox_events"
            SET "status" = 'PROCESSED',
                "processed_at" = transaction_timestamp(),
                "lease_token" = NULL,
                "lease_until" = NULL
            WHERE "id" = ${event.outboxEventId}::uuid
              AND "organization_id" = ${event.organizationId}::uuid
              AND "lease_token" = ${event.leaseToken}::uuid
            RETURNING "id"
          `);
            if ((finalizeRows as unknown as Array<{ id: string }>).length !== 1) {
              throw new Error('FINALIZATION_ATOMICITY_VIOLATED');
            }
            return { kind: 'SENT', outboxEventId: event.outboxEventId };
          }

          // REQ 6: Pas tous COMPLETED → outbox FAILED (invariant permanent).
          // Un outbox PENDING avec SEND_EMAIL COMPLETED est non-claimable par G5D
          // (besoin GENERATE_* PENDING) ni G5E (besoin SEND_EMAIL PENDING) → stuck.
          const notAllCompletedRows3 = await tx.execute(sql`
          UPDATE "outbox_events"
          SET "status" = 'FAILED',
              "lease_token" = NULL,
              "lease_until" = NULL,
              "processed_at" = NULL
          WHERE "id" = ${event.outboxEventId}::uuid
            AND "organization_id" = ${event.organizationId}::uuid
            AND "lease_token" = ${event.leaseToken}::uuid
          RETURNING "id"
        `);
          if ((notAllCompletedRows3 as unknown as Array<{ id: string }>).length !== 1) {
            throw new Error('RECONCILE_PRECONDITION_VIOLATED');
          }
          return {
            kind: 'FAILED',
            outboxEventId: event.outboxEventId,
            failureCode: 'EFFECT_SET_INVARIANT_VIOLATED',
          };
        }

        // NOT_PENDING ou RECONCILE_REQUIRED → la réconciliation a déjà été gérée
        // ci-dessus selon le statut de l'effet et de la notification.
        // Si on arrive ici avec NOT_PENDING, l'effet était PENDING (sinon on aurait
        // pris une branche précédente), donc on fait la réconciliation.
        // En pratique, NOT_PENDING ne devrait pas arriver ici car l'effet est PENDING.
        // Fail-closed défensif.
        await failClosedInTransaction(
          tx,
          event.outboxEventId,
          event.organizationId,
          event.leaseToken,
          event.sendEmailEffectId,
          'UNKNOWN_ERROR',
        );
        return {
          kind: 'FAILED',
          outboxEventId: event.outboxEventId,
          failureCode: 'EFFECT_SET_INVARIANT_VIOLATED',
        };
      });
    } catch {
      // Transaction failed (rolled back) — no counter is incremented.
      // The outbox stays PROCESSING with its lease; it will be reclaimed
      // by another worker after lease expiry.
      continue;
    }

    cResults.push(txResult);
  }

  return cResults;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Traite un batch d'événements BOOKING_CONFIRMED.v1 prêts pour l'email
 * transactionnel (3 GENERATE_* COMPLETED + SEND_EMAIL PENDING) à travers les
 * phases A, B, C.
 *
 * @param db Client base de données.
 * @param sender Fournisseur d'email transactionnel (port).
 * @param batchLimit Nombre maximum d'événements à traiter (défaut 10).
 * @returns Résultat agrégé du pipeline.
 */
/**
 * Options du pipeline d'email transactionnel.
 *
 * `onAfterPhaseB` est un seam de test exécuté après Phase B (envoi email)
 * et avant Phase C (persistance). Il permet de simuler un crash entre
 * l'acceptation email par le fournisseur et la persistance DB.
 * En production, ce hook n'est pas utilisé.
 */
export interface TransactionalEmailPipelineOptions {
  /** Hook optionnel exécuté après Phase B, avant Phase C. Tests de crash/replay. */
  readonly onAfterPhaseB?: () => Promise<void> | void;
}

export async function executeTransactionalEmailPipeline(
  db: DatabaseClient,
  sender: TransactionalEmailSender,
  batchLimit?: number,
  options?: TransactionalEmailPipelineOptions,
): Promise<TransactionalEmailPipelineResult> {
  const limit = validateBatchLimit(batchLimit);

  // Phase A — claim + init notification_deliveries.
  const {
    results: phaseAResults,
    totalClaimed,
    phaseAFailures,
  } = await phaseAClaimAndInit(db, limit);

  if (totalClaimed === 0) {
    return {
      claimedCount: 0,
      sentCount: 0,
      failedCount: 0,
      manualReviewCount: 0,
      leaseLostCount: 0,
      anomalies: [],
    };
  }

  // Phase B — send email (hors transaction).
  const phaseBResults = await phaseBSendEmail(db, sender, phaseAResults);

  // Seam de test : simuler un crash après Phase B avant Phase C.
  if (options?.onAfterPhaseB) {
    await options.onAfterPhaseB();
  }

  // Phase C — persist results (transaction courte).
  const cResults = await phaseCPersist(db, phaseBResults);

  // Agréger les compteurs APRÈS la résolution des transactions (post-commit).
  let sentCount = 0;
  let failedCount = 0;
  let manualReviewCount = 0;
  let leaseLostCount = 0;
  const anomalies: Array<{ outboxEventId: string; failureCode: string }> = [];

  // Phase A failures.
  for (const f of phaseAFailures) {
    failedCount++;
    anomalies.push({ outboxEventId: f.outboxEventId, failureCode: f.failureCode });
  }

  // Phase C results.
  for (const r of cResults) {
    if (r.kind === 'SENT') {
      sentCount++;
    } else if (r.kind === 'FAILED') {
      failedCount++;
      anomalies.push({ outboxEventId: r.outboxEventId, failureCode: r.failureCode });
    } else if (r.kind === 'LEASE_LOST') {
      leaseLostCount++;
    } else if (r.kind === 'MANUAL_REVIEW') {
      manualReviewCount++;
    }
    // TRANSIENT_RETRY, RECONCILED_NOOP et BUDGET_EXHAUSTED ne sont pas comptés ici.
  }

  return {
    claimedCount: totalClaimed,
    sentCount,
    failedCount,
    manualReviewCount,
    leaseLostCount,
    anomalies,
  };
}
