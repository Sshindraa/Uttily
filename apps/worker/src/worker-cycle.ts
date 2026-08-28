/**
 * @uttily/worker — Cycle du worker de documents transactionnels (G5F, ADR-013).
 *
 * Unité testable `runTransactionalDocumentsWorkerCycle` qui orchestre le
 * pipeline de génération documentaire PUIS le pipeline d'email, avec :
 * - isolation des erreurs (une exception globale d'un pipeline n'empêche pas
 *   l'autre pipeline de traiter les événements déjà prêts),
 * - logs structurés sans PII (logger fermé),
 * - métriques à cardinalité bornée,
 * - résultats agrégés fermés et typés.
 *
 * Les pipelines G5D (`executeDocumentPipeline`) et G5E
 * (`executeTransactionalEmailPipeline`) depuis `@uttily/core` restent les
 * autorités métier : le worker ne duplique pas leur logique.
 *
 * `runWorkerCycle` est un wrapper minimal qui construit les dépendances et
 * appelle `runTransactionalDocumentsWorkerCycle`. Il est séparé de toute
 * boucle/scheduler.
 */

import type { DatabaseClient } from '@uttily/database';
import type {
  DocumentRenderer,
  ObjectStorage,
  TransactionalEmailSender,
  NotificationEmailSender,
  ProcessNotificationBatchResult,
} from '@uttily/core';
import {
  executeDocumentPipeline,
  executeTransactionalEmailPipeline,
  emitOperationalLog,
  processDueNotifications,
} from '@uttily/core';
import type { DocumentPipelineResult, TransactionalEmailPipelineResult } from '@uttily/core';
import { validateOutboxBatchLimit } from '@uttily/core';

import type { WorkerLogger } from './logger.js';
import type { WorkerMetricsCollector } from './metrics.js';
import { normalizeFailureCode } from './failure-codes.js';
import type { WorkerFailureCode } from './failure-codes.js';
import { finalizeEmailDeliveries } from './email-delivery-finalizer.js';
import type { EmailDeliveryFinalizerResult } from './email-delivery-finalizer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types — dépendances injectées et résultats.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fonction pipeline de génération de documents, injectée pour la testabilité.
 * Par défaut, pointe vers `executeDocumentPipeline` depuis `@uttily/core`.
 */
export type DocumentPipelineFn = (
  db: DatabaseClient,
  renderer: DocumentRenderer,
  storage: ObjectStorage,
  batchLimit?: number,
) => Promise<DocumentPipelineResult>;

/**
 * Fonction pipeline d'envoi d'emails, injectée pour la testabilité.
 * Par défaut, pointe vers `executeTransactionalEmailPipeline` depuis `@uttily/core`.
 */
export type EmailPipelineFn = (
  db: DatabaseClient,
  sender: TransactionalEmailSender,
  batchLimit?: number,
) => Promise<TransactionalEmailPipelineResult>;

/**
 * Fonction finaliseur DB-only des livraisons email, injectée pour la testabilité.
 * Par défaut, pointe vers `finalizeEmailDeliveries` depuis ce module.
 */
export type EmailFinalizerFn = (
  db: DatabaseClient,
  batchLimit?: number,
) => Promise<EmailDeliveryFinalizerResult>;

/**
 * Fonction pipeline de notifications, injectée pour la testabilité.
 * Par défaut, pointe vers `processDueNotifications` depuis `@uttily/core`.
 */
export type NotificationPipelineFn = (
  db: DatabaseClient,
  sender: NotificationEmailSender,
  batchLimit?: number,
) => Promise<ProcessNotificationBatchResult>;

/**
 * Dépendances injectées du worker. Toutes les dépendances sont explicites
 * pour permettre l'injection en tests (stubs typés) et le harness local.
 */
export interface WorkerDependencies {
  readonly db: DatabaseClient;
  readonly renderer: DocumentRenderer;
  readonly storage: ObjectStorage;
  readonly sender: TransactionalEmailSender;
  readonly notificationSender?: NotificationEmailSender;
  readonly logger: WorkerLogger;
  readonly metrics: WorkerMetricsCollector;
  /** Fonction pipeline de documents (défaut : executeDocumentPipeline). */
  readonly executeDocumentPipeline: DocumentPipelineFn;
  /** Fonction pipeline d'emails (défaut : executeTransactionalEmailPipeline). */
  readonly executeTransactionalEmailPipeline: EmailPipelineFn;
  /** Fonction finaliseur DB-only des livraisons email (défaut : finalizeEmailDeliveries). */
  readonly executeEmailFinalizer?: EmailFinalizerFn;
  /** Fonction pipeline de notifications transactionnelles (défaut : processDueNotifications). */
  readonly executeNotificationsPipeline?: NotificationPipelineFn;
}

/**
 * Options d'un cycle du worker.
 */
export interface WorkerCycleOptions {
  /** Limite de batch (validée via validateOutboxBatchLimit avant traitement). */
  readonly batchLimit?: number;
}

/**
 * Résultat agrégé d'un cycle, séparant documents, finalizer, emails et notifications.
 */
export interface WorkerCycleResult {
  readonly documents: DocumentPipelineResult | PipelineGlobalFailure;
  readonly finalizer?: EmailDeliveryFinalizerResult | PipelineGlobalFailure;
  readonly emails: TransactionalEmailPipelineResult | PipelineGlobalFailure;
  readonly notifications?: ProcessNotificationBatchResult | PipelineGlobalFailure | undefined;
}

/**
 * Échec global d'un pipeline (exception non gérée par le pipeline).
 * Le failureCode est normalisé (toujours UNKNOWN_ERROR pour une exception brute).
 */
export interface PipelineGlobalFailure {
  readonly kind: 'GLOBAL_FAILURE';
  readonly failureCode: WorkerFailureCode;
}

/**
 * Type guard : vérifie si un résultat de pipeline est un échec global.
 */
export function isPipelineGlobalFailure(
  result:
    | DocumentPipelineResult
    | TransactionalEmailPipelineResult
    | EmailDeliveryFinalizerResult
    | ProcessNotificationBatchResult
    | PipelineGlobalFailure
    | undefined,
): result is PipelineGlobalFailure {
  return (
    typeof result === 'object' &&
    result !== null &&
    'kind' in result &&
    result.kind === 'GLOBAL_FAILURE'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Exécution d'un cycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exécute un cycle complet du worker : pipeline documentaire PUIS finalizer
 * PUIS pipeline email.
 *
 * Principes de conception (G5F) :
 * 1. Isolation : si le pipeline documents lève une exception globale, le
 *    cycle continue et exécute le pipeline email. Les exceptions brutes
 *    sont attrapées et normalisées en PipelineGlobalFailure avec failureCode
 *    'UNKNOWN_ERROR'. Aucune exception ne s'échappe de cette fonction.
 * 2. Observabilité : logs structurés sans PII, métriques émises aux moments
 *    clés (après commit DB uniquement, pas sur les chemins de rollback).
 * 3. Validation de configuration : batchLimit est validé via
 *    validateOutboxBatchLimit avant traitement.
 * 4. Pas de dépendance directe aux fournisseurs : tout passe par les interfaces
 *    injectées (DocumentRenderer, ObjectStorage, TransactionalEmailSender).
 */
export async function runTransactionalDocumentsWorkerCycle(
  deps: WorkerDependencies,
  options: WorkerCycleOptions = {},
): Promise<WorkerCycleResult> {
  const { logger, metrics } = deps;
  const cycleStart = Date.now();

  logger.cycleStarted();

  // Valider batchLimit avant tout traitement.
  const batchLimit = validateOutboxBatchLimit(options.batchLimit);

  // ── Pipeline documents ──────────────────────────────────────────────────
  const docStart = Date.now();
  let documents: DocumentPipelineResult | PipelineGlobalFailure;
  try {
    const docResult = await deps.executeDocumentPipeline(
      deps.db,
      deps.renderer,
      deps.storage,
      batchLimit,
    );
    const docDuration = Date.now() - docStart;

    // Logger avec compteurs post-commit.
    logger.documentPipelineCompleted({
      claimedCount: docResult.claimedCount,
      completedCount: docResult.completedCount,
      failedCount: docResult.failedCount,
      rescheduledCount: docResult.rescheduledCount,
      leaseLostCount: docResult.leaseLostCount,
      durationMs: docDuration,
    });

    // Émettre métriques documents (post-commit uniquement).
    metrics.incDocumentsClaimedTotal(docResult.claimedCount);
    metrics.incDocumentsCompletedTotal(docResult.completedCount);
    metrics.incDocumentsFailedTotal(docResult.failedCount);
    metrics.incDocumentsRescheduledTotal(docResult.rescheduledCount);
    metrics.incLeaseLostTotal('documents', docResult.leaseLostCount);

    // Anomalies documents (failureCode normalisé).
    for (const anomaly of docResult.anomalies) {
      const normalizedCode = normalizeFailureCode(anomaly.failureCode);
      logger.anomalyDetected({
        pipeline: 'documents',
        outboxEventId: anomaly.outboxEventId,
        effectType: anomaly.effectType,
        failureCode: normalizedCode,
      });
      metrics.incAnomaliesTotal('documents', normalizedCode, 1);
    }

    documents = docResult;
  } catch {
    // Une exception globale du pipeline documents est normalisée.
    // Aucune exception brute ou message fournisseur n'est propagé.
    const docDuration = Date.now() - docStart;
    const failureCode: WorkerFailureCode = 'UNKNOWN_ERROR';
    logger.pipelineFailed({
      pipeline: 'documents',
      outcome: 'failed',
      failureCode,
      durationMs: docDuration,
    });
    metrics.incCycleFailuresTotal('documents');
    documents = { kind: 'GLOBAL_FAILURE', failureCode };
  }

  // ── Finalizer DB-only ───────────────────────────────────────────────────
  // Marque les livraisons email en retry window expirée ou MAX_ATTEMPS
  // épuisé en REQUIRES_MANUAL_REVIEW. Une erreur globale du finalizer ne
  // bloque pas l'email pipeline : les emails déjà prêts doivent être traités.
  let finalizer: EmailDeliveryFinalizerResult | PipelineGlobalFailure;
  const executeEmailFinalizer = deps.executeEmailFinalizer ?? finalizeEmailDeliveries;
  try {
    const finalizerResult = await executeEmailFinalizer(deps.db, batchLimit);

    logger.finalizerCompleted({
      finalizedCount: finalizerResult.finalizedCount,
      inspectedCount: finalizerResult.inspectedCount,
      inconsistentCount: finalizerResult.inconsistentCount,
    });

    metrics.incFinalizerFinalizedTotal(finalizerResult.finalizedCount);
    metrics.incFinalizerCutoffTotal(finalizerResult.cutoffCount);
    metrics.incFinalizerUncertainTotal(finalizerResult.uncertainCount);
    metrics.incFinalizerInconsistentTotal(finalizerResult.inconsistentCount);

    finalizer = finalizerResult;
  } catch (error) {
    // Une exception globale du finalizer est normalisée. Le cycle continue
    // vers l'email pipeline : le finalizer est secondaire par rapport à
    // l'envoi des emails déjà prêts.
    const failureCode = normalizeFailureCode(
      error instanceof Error ? error.message : 'UNKNOWN_ERROR',
    );
    logger.finalizerFailed({ failureCode });
    metrics.incFinalizerFailedTotal('finalizer', failureCode);
    finalizer = { kind: 'GLOBAL_FAILURE', failureCode };
  }

  // ── Pipeline emails ─────────────────────────────────────────────────────
  // Le pipeline email s'exécute même si le pipeline documents ou le finalizer
  // a levé globalement : des événements peuvent déjà être prêts pour l'email
  // (effets GENERATE_* COMPLETED d'un cycle précédent).
  const emailStart = Date.now();
  let emails: TransactionalEmailPipelineResult | PipelineGlobalFailure;
  try {
    const emailResult = await deps.executeTransactionalEmailPipeline(
      deps.db,
      deps.sender,
      batchLimit,
    );
    const emailDuration = Date.now() - emailStart;

    // Logger avec compteurs post-commit.
    logger.emailPipelineCompleted({
      claimedCount: emailResult.claimedCount,
      sentCount: emailResult.sentCount,
      failedCount: emailResult.failedCount,
      manualReviewCount: emailResult.manualReviewCount,
      leaseLostCount: emailResult.leaseLostCount,
      durationMs: emailDuration,
    });

    // Émettre métriques emails (post-commit uniquement).
    metrics.incEmailsClaimedTotal(emailResult.claimedCount);
    metrics.incEmailsSentTotal(emailResult.sentCount);
    metrics.incEmailsFailedTotal(emailResult.failedCount);
    metrics.incLeaseLostTotal('emails', emailResult.leaseLostCount);

    // Anomalies emails (failureCode normalisé).
    for (const anomaly of emailResult.anomalies) {
      const normalizedCode = normalizeFailureCode(anomaly.failureCode);
      logger.anomalyDetected({
        pipeline: 'emails',
        outboxEventId: anomaly.outboxEventId,
        effectType: 'SEND_EMAIL',
        failureCode: normalizedCode,
      });
      metrics.incAnomaliesTotal('emails', normalizedCode, 1);
    }

    emails = emailResult;
  } catch {
    // Une exception globale du pipeline email est normalisée.
    // Aucune exception brute ou message fournisseur n'est propagé.
    const emailDuration = Date.now() - emailStart;
    const failureCode: WorkerFailureCode = 'UNKNOWN_ERROR';
    logger.pipelineFailed({
      pipeline: 'emails',
      outcome: 'failed',
      failureCode,
      durationMs: emailDuration,
    });
    metrics.incCycleFailuresTotal('emails');
    emails = { kind: 'GLOBAL_FAILURE', failureCode };
  }

  // ── Pipeline notifications transactionnelles (Chantier 13.1) ───────────
  let notifications: ProcessNotificationBatchResult | PipelineGlobalFailure | undefined;
  if (deps.notificationSender && deps.executeNotificationsPipeline) {
    const notificationStart = Date.now();
    try {
      notifications = await deps.executeNotificationsPipeline(
        deps.db,
        deps.notificationSender,
        batchLimit,
      );
      emitOperationalLog({
        operation: 'notifications',
        outcome:
          notifications.failedCount > 0 || notifications.leaseLostCount > 0
            ? 'degraded'
            : 'success',
        durationMs: Date.now() - notificationStart,
        counts: {
          claimed: notifications.claimedCount,
          sent: notifications.sentCount,
          failed: notifications.failedCount,
          retried: notifications.retriedCount,
          cancelled: notifications.cancelledCount,
          expiredLeases: notifications.leaseLostCount,
        },
      });
    } catch {
      const failureCode: WorkerFailureCode = 'UNKNOWN_ERROR';
      emitOperationalLog({
        operation: 'notifications',
        outcome: 'failed',
        durationMs: Date.now() - notificationStart,
        errorCode: failureCode,
      });
      notifications = { kind: 'GLOBAL_FAILURE', failureCode };
    }
  }

  // ── Cycle completed ─────────────────────────────────────────────────────
  const cycleDuration = Date.now() - cycleStart;
  const cycleOutcome =
    isPipelineGlobalFailure(documents) ||
    isPipelineGlobalFailure(emails) ||
    isPipelineGlobalFailure(finalizer) ||
    (notifications !== undefined && isPipelineGlobalFailure(notifications))
      ? ('failed' as const)
      : ('success' as const);
  logger.cycleCompleted({
    outcome: cycleOutcome,
    durationMs: cycleDuration,
  });
  metrics.incWorkerCyclesTotal(cycleOutcome);

  return { documents, finalizer, emails, notifications };
}

// ─────────────────────────────────────────────────────────────────────────────
// runWorkerCycle — wrapper minimal qui construit les dépendances.
// Séparé de toute boucle/scheduler.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrapper minimal qui construit les dépendances par défaut (vraies fonctions
 * pipeline depuis `@uttily/core`) et appelle `runTransactionalDocumentsWorkerCycle`.
 *
 * Les dépendances (db, renderer, storage, sender, logger, metrics) doivent
 * être fournies par l'appelant. Ce wrapper ne construit PAS de fournisseurs
 * réels — ces décisions sont ouvertes dans ADR-013 (questions 6, 7, 14).
 */
export async function runWorkerCycle(
  deps: Omit<WorkerDependencies, 'executeDocumentPipeline' | 'executeTransactionalEmailPipeline'>,
  options: WorkerCycleOptions = {},
): Promise<WorkerCycleResult> {
  return runTransactionalDocumentsWorkerCycle(
    {
      ...deps,
      executeDocumentPipeline,
      executeTransactionalEmailPipeline,
      executeEmailFinalizer: deps.executeEmailFinalizer ?? finalizeEmailDeliveries,
      executeNotificationsPipeline:
        deps.executeNotificationsPipeline ??
        ((db, sender, limit) =>
          processDueNotifications(
            { db, emailSender: sender },
            limit !== undefined ? { batchLimit: limit } : undefined,
          )),
    },
    options,
  );
}
