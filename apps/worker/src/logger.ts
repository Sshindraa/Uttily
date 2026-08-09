/**
 * @uttily/worker — Logger structuré fermé pour le worker (G5F, ADR-013).
 *
 * Le port `WorkerLogger` expose une méthode typée précise par événement.
 * Chaque méthode n'accepte QUE les champs autorisés pour cet événement,
 * avec des types fermés. Aucun objet arbitraire ou `unknown` n'est accepté.
 *
 * Interdictions STRICTES (refusées à la compilation par le typage) :
 * - recipientEmail, nom client/organisation, adresse, snapshot/payload,
 *   providerMessageId, storageKey, document binaire, raw Error/message/stack,
 *   variables d'environnement, chaîne de connexion.
 *
 * Le logger ne sérialise jamais aveuglément un objet. Chaque événement a une
 * signature précise et seuls les champs déclarés sont sérialisés.
 */

import type { WorkerFailureCode } from './failure-codes.js';

/**
 * Identifiant de pipeline dans les logs.
 */
export type PipelineLabel = 'documents' | 'emails';

/**
 * Résultat d'un cycle ou pipeline.
 */
export type OutcomeLabel = 'success' | 'failed';

// ─────────────────────────────────────────────────────────────────────────────
// Types d'événements fermés — chaque événement a ses propres champs.
// ─────────────────────────────────────────────────────────────────────────────

export interface CycleStartedEvent {
  readonly event: 'cycle_started';
  readonly timestamp: number;
}

export interface DocumentPipelineCompletedEvent {
  readonly event: 'document_pipeline_completed';
  readonly timestamp: number;
  readonly pipeline: 'documents';
  readonly outcome: 'success';
  readonly claimedCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly rescheduledCount: number;
  readonly leaseLostCount: number;
  readonly durationMs: number;
}

export interface EmailPipelineCompletedEvent {
  readonly event: 'email_pipeline_completed';
  readonly timestamp: number;
  readonly pipeline: 'emails';
  readonly outcome: 'success';
  readonly claimedCount: number;
  readonly sentCount: number;
  readonly failedCount: number;
  readonly manualReviewCount: number;
  readonly leaseLostCount: number;
  readonly durationMs: number;
}

export interface PipelineFailedEvent {
  readonly event: 'pipeline_failed';
  readonly timestamp: number;
  readonly pipeline: PipelineLabel;
  readonly outcome: 'failed';
  readonly failureCode: WorkerFailureCode;
  readonly durationMs: number;
}

export interface AnomalyDetectedEvent {
  readonly event: 'anomaly_detected';
  readonly timestamp: number;
  readonly pipeline: PipelineLabel;
  readonly outboxEventId: string;
  readonly effectType: string;
  readonly failureCode: WorkerFailureCode;
}

export interface CycleCompletedEvent {
  readonly event: 'cycle_completed';
  readonly timestamp: number;
  readonly outcome: OutcomeLabel;
  readonly durationMs: number;
}

export interface FinalizerCompletedEvent {
  readonly event: 'finalizer_completed';
  readonly timestamp: number;
  readonly finalizedCount: number;
  readonly inspectedCount: number;
  readonly inconsistentCount: number;
}

export interface FinalizerFailedEvent {
  readonly event: 'finalizer_failed';
  readonly timestamp: number;
  readonly failureCode: WorkerFailureCode;
}

/**
 * Union fermée de tous les événements de log autorisés.
 */
export type WorkerLogEvent =
  | CycleStartedEvent
  | DocumentPipelineCompletedEvent
  | EmailPipelineCompletedEvent
  | PipelineFailedEvent
  | AnomalyDetectedEvent
  | CycleCompletedEvent
  | FinalizerCompletedEvent
  | FinalizerFailedEvent;

/**
 * Port logger fermé. Chaque méthode correspond à un événement autorisé.
 * Aucune méthode générique n'accepte un objet arbitraire.
 */
export interface WorkerLogger {
  cycleStarted(): void;
  documentPipelineCompleted(
    event: Omit<DocumentPipelineCompletedEvent, 'event' | 'timestamp' | 'pipeline' | 'outcome'>,
  ): void;
  emailPipelineCompleted(
    event: Omit<EmailPipelineCompletedEvent, 'event' | 'timestamp' | 'pipeline' | 'outcome'>,
  ): void;
  pipelineFailed(event: Omit<PipelineFailedEvent, 'event' | 'timestamp'>): void;
  anomalyDetected(event: Omit<AnomalyDetectedEvent, 'event' | 'timestamp'>): void;
  cycleCompleted(event: Omit<CycleCompletedEvent, 'event' | 'timestamp'>): void;
  finalizerCompleted(event: Omit<FinalizerCompletedEvent, 'event' | 'timestamp'>): void;
  finalizerFailed(event: Omit<FinalizerFailedEvent, 'event' | 'timestamp'>): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implémentation ConsoleWorkerLogger — console.info avec JSON structuré.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Logger qui émet des événements JSON structurés via console.info.
 * Aucune PII n'est incluse : seuls les champs typés sont sérialisés.
 */
export class ConsoleWorkerLogger implements WorkerLogger {
  cycleStarted(): void {
    this.emit({ event: 'cycle_started', timestamp: Date.now() });
  }

  documentPipelineCompleted(
    event: Omit<DocumentPipelineCompletedEvent, 'event' | 'timestamp' | 'pipeline' | 'outcome'>,
  ): void {
    this.emit({
      event: 'document_pipeline_completed',
      timestamp: Date.now(),
      pipeline: 'documents',
      outcome: 'success',
      ...event,
    });
  }

  emailPipelineCompleted(
    event: Omit<EmailPipelineCompletedEvent, 'event' | 'timestamp' | 'pipeline' | 'outcome'>,
  ): void {
    this.emit({
      event: 'email_pipeline_completed',
      timestamp: Date.now(),
      pipeline: 'emails',
      outcome: 'success',
      ...event,
    });
  }

  pipelineFailed(event: Omit<PipelineFailedEvent, 'event' | 'timestamp'>): void {
    this.emit({
      event: 'pipeline_failed',
      timestamp: Date.now(),
      ...event,
    });
  }

  anomalyDetected(event: Omit<AnomalyDetectedEvent, 'event' | 'timestamp'>): void {
    this.emit({
      event: 'anomaly_detected',
      timestamp: Date.now(),
      ...event,
    });
  }

  cycleCompleted(event: Omit<CycleCompletedEvent, 'event' | 'timestamp'>): void {
    this.emit({
      event: 'cycle_completed',
      timestamp: Date.now(),
      ...event,
    });
  }

  finalizerCompleted(event: Omit<FinalizerCompletedEvent, 'event' | 'timestamp'>): void {
    this.emit({
      event: 'finalizer_completed',
      timestamp: Date.now(),
      ...event,
    });
  }

  finalizerFailed(event: Omit<FinalizerFailedEvent, 'event' | 'timestamp'>): void {
    this.emit({
      event: 'finalizer_failed',
      timestamp: Date.now(),
      ...event,
    });
  }

  private emit(event: WorkerLogEvent): void {
    // console.info avec JSON structuré. Aucun PII n'est présent dans le type.
    console.info(JSON.stringify(event));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CapturingWorkerLogger — capture les événements sans les retransmettre.
// Pour les tests uniquement.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Logger de test qui capture tous les événements sans les retransmettre
 * à la console. Expose `events` pour les assertions.
 *
 * NE PAS utiliser en production.
 */
export class CapturingWorkerLogger implements WorkerLogger {
  readonly events: WorkerLogEvent[] = [];

  cycleStarted(): void {
    this.events.push({ event: 'cycle_started', timestamp: Date.now() });
  }

  documentPipelineCompleted(
    event: Omit<DocumentPipelineCompletedEvent, 'event' | 'timestamp' | 'pipeline' | 'outcome'>,
  ): void {
    this.events.push({
      event: 'document_pipeline_completed',
      timestamp: Date.now(),
      pipeline: 'documents',
      outcome: 'success',
      ...event,
    });
  }

  emailPipelineCompleted(
    event: Omit<EmailPipelineCompletedEvent, 'event' | 'timestamp' | 'pipeline' | 'outcome'>,
  ): void {
    this.events.push({
      event: 'email_pipeline_completed',
      timestamp: Date.now(),
      pipeline: 'emails',
      outcome: 'success',
      ...event,
    });
  }

  pipelineFailed(event: Omit<PipelineFailedEvent, 'event' | 'timestamp'>): void {
    this.events.push({
      event: 'pipeline_failed',
      timestamp: Date.now(),
      ...event,
    });
  }

  anomalyDetected(event: Omit<AnomalyDetectedEvent, 'event' | 'timestamp'>): void {
    this.events.push({
      event: 'anomaly_detected',
      timestamp: Date.now(),
      ...event,
    });
  }

  cycleCompleted(event: Omit<CycleCompletedEvent, 'event' | 'timestamp'>): void {
    this.events.push({
      event: 'cycle_completed',
      timestamp: Date.now(),
      ...event,
    });
  }

  finalizerCompleted(event: Omit<FinalizerCompletedEvent, 'event' | 'timestamp'>): void {
    this.events.push({
      event: 'finalizer_completed',
      timestamp: Date.now(),
      ...event,
    });
  }

  finalizerFailed(event: Omit<FinalizerFailedEvent, 'event' | 'timestamp'>): void {
    this.events.push({
      event: 'finalizer_failed',
      timestamp: Date.now(),
      ...event,
    });
  }

  /** Réinitialise les événements capturés. */
  reset(): void {
    this.events.length = 0;
  }

  /** Retourne la représentation JSON sérialisée de tous les événements. */
  serialized(): string {
    return JSON.stringify(this.events);
  }
}
