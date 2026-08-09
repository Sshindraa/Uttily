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
import type { DocumentRenderer, ObjectStorage, TransactionalEmailSender } from '@uttily/core';
import { executeDocumentPipeline, executeTransactionalEmailPipeline } from '@uttily/core';
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
 * Dépendances injectées du worker. Toutes les dépendances sont explicites
 * pour permettre l'injection en tests (stubs typés) et le harness local.
 */
export interface WorkerDependencies {
  readonly db: DatabaseClient;
  readonly renderer: DocumentRenderer;
  readonly storage: ObjectStorage;
  readonly sender: TransactionalEmailSender;
  readonly logger: WorkerLogger;
  readonly metrics: WorkerMetricsCollector;
  /** Fonction pipeline de documents (défaut : executeDocumentPipeline). */
  readonly executeDocumentPipeline: DocumentPipelineFn;
  /** Fonction pipeline d'emails (défaut : executeTransactionalEmailPipeline). */
  readonly executeTransactionalEmailPipeline: EmailPipelineFn;
  /** Fonction finaliseur DB-only des livraisons email (défaut : finalizeEmailDeliveries). */
  readonly executeEmailFinalizer?: EmailFinalizerFn;
}

/**
 * Options d'un cycle du worker.
 */
export interface WorkerCycleOptions {
  /** Limite de batch (validée via validateOutboxBatchLimit avant traitement). */
  readonly batchLimit?: number;
}

/**
 * Résultat agrégé d'un cycle, séparant documents, finalizer et emails.
 */
export interface WorkerCycleResult {
  readonly documents: DocumentPipelineResult | PipelineGlobalFailure;
  readonly finalizer?: EmailDeliveryFinalizerResult | PipelineGlobalFailure;
  readonly emails: TransactionalEmailPipelineResult | PipelineGlobalFailure;
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
    | PipelineGlobalFailure,
): result is PipelineGlobalFailure {
  return (
    typeof result === 'object' &&
    result !== null &&
    'kind' in result &&
    result.kind === 'GLOBAL_FAILURE'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cycle principal — unité testable.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exécute un cycle complet du worker de documents transactionnels :
 * 1. Logger cycle_started.
 * 2. Exécuter executeDocumentPipeline (pipeline documents).
 * 3. Logger document_pipeline_completed avec compteurs post-commit.
 * 4. Émettre métriques documents.
 * 5. Exécuter executeEmailFinalizer (finalizer DB-only des livraisons email).
 * 6. Logger finalizer_completed / finalizer_failed.
 * 7. Exécuter executeTransactionalEmailPipeline (pipeline emails).
 * 8. Logger email_pipeline_completed avec compteurs post-commit.
 * 9. Émettre métriques emails.
 * 10. Retourner un résultat agrégé fermé.
 * 11. Logger cycle_completed.
 *
 * Isolation des erreurs :
 * - Une exception globale du pipeline documents est normalisée (UNKNOWN_ERROR),
 *   journalisée via pipeline_failed (pipeline='documents'), et NE doit PAS
 *   empêcher le traitement d'événements déjà prêts pour l'email.
 * - Une exception globale du pipeline email est normalisée, journalisée via
 *   pipeline_failed (pipeline='emails'), et NE doit pas falsifier le résultat
 *   documentaire.
 * - Aucune exception brute ou message fournisseur n'est propagé dans
 *   logs/métriques. Le logger ne reçoit que des failureCode normalisés.
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

  // Défaut finaliseur DB-only si non injecté.
  const executeEmailFinalizer = deps.executeEmailFinalizer ?? finalizeEmailDeliveries;

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

  // ── Cycle completed ─────────────────────────────────────────────────────
  const cycleDuration = Date.now() - cycleStart;
  const cycleOutcome =
    isPipelineGlobalFailure(documents) ||
    isPipelineGlobalFailure(emails) ||
    isPipelineGlobalFailure(finalizer)
      ? ('failed' as const)
      : ('success' as const);
  logger.cycleCompleted({
    outcome: cycleOutcome,
    durationMs: cycleDuration,
  });
  metrics.incWorkerCyclesTotal(cycleOutcome);

  return { documents, finalizer, emails };
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
    },
    options,
  );
}
