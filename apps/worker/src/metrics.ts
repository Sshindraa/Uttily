/**
 * @uttily/worker — Port de métriques fermé pour le worker (G5F, ADR-013).
 *
 * Métriques à cardinalité strictement bornée. Les labels autorisés sont
 * uniquement : `pipeline: 'documents' | 'emails'`,
 * `outcome: 'success' | 'failed'`, `failureCode: WorkerFailureCode`.
 *
 * Interdits comme labels : UUID, bookingId, organizationId, email,
 * providerMessageId, storageKey, ou toute valeur à cardinalité non bornée.
 *
 * Les métriques sont émises à partir des résultats post-commit des pipelines
 * (jamais avant). Aucune métrique de succès n'est émise si la transaction
 * correspondante a été rollback (les pipelines retournent déjà des compteurs
 * post-commit).
 */

import type { WorkerFailureCode } from './failure-codes';
import type { PipelineLabel, OutcomeLabel } from './logger';

/**
 * Port minimal de collecte de métriques.
 *
 * Toutes les méthodes sont typées avec des labels fermés. Aucune méthode
 * générique n'accepte des labels arbitraires.
 */
export interface WorkerMetricsCollector {
  /** Compteur de cycles du worker (labels: outcome). */
  incWorkerCyclesTotal(outcome: OutcomeLabel): void;

  /** Documents claimés. */
  incDocumentsClaimedTotal(count: number): void;
  /** Documents complétés. */
  incDocumentsCompletedTotal(count: number): void;
  /** Documents échoués. */
  incDocumentsFailedTotal(count: number): void;
  /** Documents rescheduled. */
  incDocumentsRescheduledTotal(count: number): void;

  /** Emails claimés. */
  incEmailsClaimedTotal(count: number): void;
  /** Emails envoyés. */
  incEmailsSentTotal(count: number): void;
  /** Emails échoués. */
  incEmailsFailedTotal(count: number): void;

  /** Lease perdu (labels: pipeline). */
  incLeaseLostTotal(pipeline: PipelineLabel, count: number): void;

  /** Anomalies détectées (labels: pipeline, failureCode normalisé). */
  incAnomaliesTotal(pipeline: PipelineLabel, failureCode: WorkerFailureCode, count: number): void;

  /** Échec global d'un pipeline (labels: pipeline). */
  incCycleFailuresTotal(pipeline: PipelineLabel): void;

  /** Emails finalisés avec succès (DB-only finalizer). */
  incFinalizerFinalizedTotal(count: number): void;
  /** Emails abandonnés car la fenêtre de retry est expirée. */
  incFinalizerCutoffTotal(count: number): void;
  /** Emails marqués incertains par le provider. */
  incFinalizerUncertainTotal(count: number): void;
  /** Emails avec un état incohérent détecté par le finalizer. */
  incFinalizerInconsistentTotal(count: number): void;
  /** Échec global du finalizer (labels: pipeline, failureCode). */
  incFinalizerFailedTotal(pipeline: 'finalizer', failureCode: WorkerFailureCode): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// InMemoryMetricsCollector — pour les tests uniquement.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Snapshot sérialisable des compteurs et labels.
 */
export interface MetricsSnapshot {
  readonly workerCyclesTotal: Record<OutcomeLabel, number>;
  readonly documentsClaimedTotal: number;
  readonly documentsCompletedTotal: number;
  readonly documentsFailedTotal: number;
  readonly documentsRescheduledTotal: number;
  readonly emailsClaimedTotal: number;
  readonly emailsSentTotal: number;
  readonly emailsFailedTotal: number;
  readonly leaseLostTotal: Record<PipelineLabel, number>;
  readonly anomaliesTotal: Record<PipelineLabel, Partial<Record<WorkerFailureCode, number>>>;
  readonly cycleFailuresTotal: Record<PipelineLabel, number>;
  readonly finalizerFinalizedTotal: number;
  readonly finalizerCutoffTotal: number;
  readonly finalizerUncertainTotal: number;
  readonly finalizerInconsistentTotal: number;
  readonly finalizerFailedTotal: Partial<Record<WorkerFailureCode, number>>;
}

/**
 * Collecteur de métriques en mémoire, déterministe, pour les tests.
 *
 * NE PAS utiliser en production. Expose `snapshot()` retournant une structure
 * sérialisable des compteurs et labels.
 */
export class InMemoryMetricsCollector implements WorkerMetricsCollector {
  private workerCyclesTotal: Record<OutcomeLabel, number> = { success: 0, failed: 0 };
  private documentsClaimed = 0;
  private documentsCompleted = 0;
  private documentsFailed = 0;
  private documentsRescheduled = 0;
  private emailsClaimed = 0;
  private emailsSent = 0;
  private emailsFailed = 0;
  private leaseLostTotal: Record<PipelineLabel, number> = { documents: 0, emails: 0 };
  private anomaliesTotal: Record<PipelineLabel, Partial<Record<WorkerFailureCode, number>>> = {
    documents: {},
    emails: {},
  };
  private cycleFailuresTotal: Record<PipelineLabel, number> = { documents: 0, emails: 0 };
  private finalizerFinalized = 0;
  private finalizerCutoff = 0;
  private finalizerUncertain = 0;
  private finalizerInconsistent = 0;
  private finalizerFailedTotal: Partial<Record<WorkerFailureCode, number>> = {};

  incWorkerCyclesTotal(outcome: OutcomeLabel): void {
    this.workerCyclesTotal[outcome]++;
  }

  incDocumentsClaimedTotal(count: number): void {
    this.documentsClaimed += count;
  }

  incDocumentsCompletedTotal(count: number): void {
    this.documentsCompleted += count;
  }

  incDocumentsFailedTotal(count: number): void {
    this.documentsFailed += count;
  }

  incDocumentsRescheduledTotal(count: number): void {
    this.documentsRescheduled += count;
  }

  incEmailsClaimedTotal(count: number): void {
    this.emailsClaimed += count;
  }

  incEmailsSentTotal(count: number): void {
    this.emailsSent += count;
  }

  incEmailsFailedTotal(count: number): void {
    this.emailsFailed += count;
  }

  incLeaseLostTotal(pipeline: PipelineLabel, count: number): void {
    this.leaseLostTotal[pipeline] += count;
  }

  incAnomaliesTotal(pipeline: PipelineLabel, failureCode: WorkerFailureCode, count: number): void {
    const current = this.anomaliesTotal[pipeline][failureCode] ?? 0;
    this.anomaliesTotal[pipeline][failureCode] = current + count;
  }

  incCycleFailuresTotal(pipeline: PipelineLabel): void {
    this.cycleFailuresTotal[pipeline]++;
  }

  incFinalizerFinalizedTotal(count: number): void {
    this.finalizerFinalized += count;
  }

  incFinalizerCutoffTotal(count: number): void {
    this.finalizerCutoff += count;
  }

  incFinalizerUncertainTotal(count: number): void {
    this.finalizerUncertain += count;
  }

  incFinalizerInconsistentTotal(count: number): void {
    this.finalizerInconsistent += count;
  }

  incFinalizerFailedTotal(_pipeline: 'finalizer', failureCode: WorkerFailureCode): void {
    const current = this.finalizerFailedTotal[failureCode] ?? 0;
    this.finalizerFailedTotal[failureCode] = current + 1;
  }

  /** Retourne une structure sérialisable des compteurs et labels. */
  snapshot(): MetricsSnapshot {
    return {
      workerCyclesTotal: { ...this.workerCyclesTotal },
      documentsClaimedTotal: this.documentsClaimed,
      documentsCompletedTotal: this.documentsCompleted,
      documentsFailedTotal: this.documentsFailed,
      documentsRescheduledTotal: this.documentsRescheduled,
      emailsClaimedTotal: this.emailsClaimed,
      emailsSentTotal: this.emailsSent,
      emailsFailedTotal: this.emailsFailed,
      leaseLostTotal: { ...this.leaseLostTotal },
      anomaliesTotal: {
        documents: { ...this.anomaliesTotal.documents },
        emails: { ...this.anomaliesTotal.emails },
      },
      cycleFailuresTotal: { ...this.cycleFailuresTotal },
      finalizerFinalizedTotal: this.finalizerFinalized,
      finalizerCutoffTotal: this.finalizerCutoff,
      finalizerUncertainTotal: this.finalizerUncertain,
      finalizerInconsistentTotal: this.finalizerInconsistent,
      finalizerFailedTotal: { ...this.finalizerFailedTotal },
    };
  }

  /** Réinitialise tous les compteurs. */
  reset(): void {
    this.workerCyclesTotal = { success: 0, failed: 0 };
    this.documentsClaimed = 0;
    this.documentsCompleted = 0;
    this.documentsFailed = 0;
    this.documentsRescheduled = 0;
    this.emailsClaimed = 0;
    this.emailsSent = 0;
    this.emailsFailed = 0;
    this.leaseLostTotal = { documents: 0, emails: 0 };
    this.anomaliesTotal = { documents: {}, emails: {} };
    this.cycleFailuresTotal = { documents: 0, emails: 0 };
    this.finalizerFinalized = 0;
    this.finalizerCutoff = 0;
    this.finalizerUncertain = 0;
    this.finalizerInconsistent = 0;
    this.finalizerFailedTotal = {};
  }
}
