/**
 * @uttily/worker — Tests unitaires du cycle du worker (G5F).
 *
 * Couvre SANS PostgreSQL (stubs typés injectés) :
 * 1. Ordre documents puis email.
 * 2. Email exécuté même si le pipeline documents lève globalement (isolation).
 * 3. Résultats des deux étapes agrégés sans mélange.
 * 4. Normalisation exhaustive des failure codes.
 * 5. Aucune valeur inconnue ou brute dans logs/métriques.
 * 6. Labels métriques bornés.
 * 7. Aucune PII admise dans le contrat logger (vérification de type à la compilation).
 * 8. Erreur de configuration sans valeur d'environnement.
 * 9. batchLimit invalide rejeté avant traitement.
 */

import { describe, it, expect } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import type { DocumentRenderer, ObjectStorage, TransactionalEmailSender } from '@uttily/core';
import type { DocumentPipelineResult, TransactionalEmailPipelineResult } from '@uttily/core';

import { runTransactionalDocumentsWorkerCycle, isPipelineGlobalFailure } from './worker-cycle';
import type { WorkerDependencies } from './worker-cycle';
import { CapturingWorkerLogger } from './logger';
import type { WorkerLogEvent } from './logger';
import { InMemoryMetricsCollector } from './metrics';
import { WorkerConfigurationError, createWorkerDependenciesFromEnv } from './index';
import type { EmailDeliveryFinalizerResult } from './email-delivery-finalizer';

// ─────────────────────────────────────────────────────────────────────────────
// Stubs typés pour les tests unitaires (sans PostgreSQL).
// ─────────────────────────────────────────────────────────────────────────────

function createStubDeps(overrides?: {
  docPipeline?: (
    db: DatabaseClient,
    renderer: DocumentRenderer,
    storage: ObjectStorage,
    batchLimit?: number,
  ) => Promise<DocumentPipelineResult>;
  emailPipeline?: (
    db: DatabaseClient,
    sender: TransactionalEmailSender,
    batchLimit?: number,
  ) => Promise<TransactionalEmailPipelineResult>;
  finalizer?: (db: DatabaseClient, batchLimit?: number) => Promise<EmailDeliveryFinalizerResult>;
}): {
  deps: WorkerDependencies;
  logger: CapturingWorkerLogger;
  metrics: InMemoryMetricsCollector;
  docCallCount: () => number;
  emailCallCount: () => number;
  finalizerCallCount: () => number;
} {
  const logger = new CapturingWorkerLogger();
  const metrics = new InMemoryMetricsCollector();

  let docCalls = 0;
  let emailCalls = 0;
  let finalizerCalls = 0;

  const stubDb = {} as DatabaseClient;
  const stubRenderer = {} as DocumentRenderer;
  const stubStorage = {} as ObjectStorage;
  const stubSender = {} as TransactionalEmailSender;

  const defaultDocResult: DocumentPipelineResult = {
    claimedCount: 1,
    completedCount: 3,
    failedCount: 0,
    rescheduledCount: 0,
    leaseLostCount: 0,
    anomalies: [],
  };

  const defaultEmailResult: TransactionalEmailPipelineResult = {
    claimedCount: 1,
    sentCount: 1,
    failedCount: 0,
    manualReviewCount: 0,
    leaseLostCount: 0,
    anomalies: [],
  };

  const docPipeline =
    overrides?.docPipeline ??
    (async () => {
      docCalls++;
      return defaultDocResult;
    });

  const emailPipeline =
    overrides?.emailPipeline ??
    (async () => {
      emailCalls++;
      return defaultEmailResult;
    });

  const defaultFinalizerResult: EmailDeliveryFinalizerResult = {
    inspectedCount: 0,
    finalizedCount: 0,
    cutoffCount: 0,
    uncertainCount: 0,
    inconsistentCount: 0,
  };

  const finalizer =
    overrides?.finalizer ??
    (async () => {
      finalizerCalls++;
      return defaultFinalizerResult;
    });

  const deps: WorkerDependencies = {
    db: stubDb,
    renderer: stubRenderer,
    storage: stubStorage,
    sender: stubSender,
    logger,
    metrics,
    executeDocumentPipeline: docPipeline,
    executeTransactionalEmailPipeline: emailPipeline,
    executeEmailFinalizer: finalizer,
  };

  return {
    deps,
    logger,
    metrics,
    docCallCount: () => docCalls,
    emailCallCount: () => emailCalls,
    finalizerCallCount: () => finalizerCalls,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests.
// ─────────────────────────────────────────────────────────────────────────────

describe('runTransactionalDocumentsWorkerCycle', () => {
  // 1. Ordre documents puis email.
  it('1. exécute le pipeline documents avant le pipeline email', async () => {
    const callOrder: string[] = [];
    const { deps } = createStubDeps({
      docPipeline: async () => {
        callOrder.push('documents');
        return {
          claimedCount: 1,
          completedCount: 3,
          failedCount: 0,
          rescheduledCount: 0,
          leaseLostCount: 0,
          anomalies: [],
        };
      },
      emailPipeline: async () => {
        callOrder.push('emails');
        return {
          claimedCount: 1,
          sentCount: 1,
          failedCount: 0,
          manualReviewCount: 0,
          leaseLostCount: 0,
          anomalies: [],
        };
      },
    });

    await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 5 });

    expect(callOrder).toEqual(['documents', 'emails']);
  });

  // 1b. Finalizer exécuté avant le pipeline email.
  it('1b. exécute le finalizer avant le pipeline email', async () => {
    const callOrder: string[] = [];
    const { deps } = createStubDeps({
      finalizer: async () => {
        callOrder.push('finalizer');
        return {
          inspectedCount: 1,
          finalizedCount: 1,
          cutoffCount: 0,
          uncertainCount: 1,
          inconsistentCount: 0,
        };
      },
      emailPipeline: async () => {
        callOrder.push('emails');
        return {
          claimedCount: 1,
          sentCount: 1,
          failedCount: 0,
          manualReviewCount: 0,
          leaseLostCount: 0,
          anomalies: [],
        };
      },
    });

    await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 5 });

    expect(callOrder).toEqual(['finalizer', 'emails']);
  });

  // 1c. Le finalizer retourne des revues manuelles, mais l'email pipeline continue.
  it('1c. le pipeline email continue même si le finalizer retourne des revues manuelles', async () => {
    let emailExecuted = false;
    const { deps } = createStubDeps({
      finalizer: async () => ({
        inspectedCount: 2,
        finalizedCount: 2,
        cutoffCount: 1,
        uncertainCount: 1,
        inconsistentCount: 0,
      }),
      emailPipeline: async () => {
        emailExecuted = true;
        return {
          claimedCount: 1,
          sentCount: 1,
          failedCount: 0,
          manualReviewCount: 0,
          leaseLostCount: 0,
          anomalies: [],
        };
      },
    });

    const result = await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 5 });

    expect(emailExecuted).toBe(true);
    expect(result.finalizer).toBeDefined();
    if (result.finalizer && !isPipelineGlobalFailure(result.finalizer)) {
      expect(result.finalizer.finalizedCount).toBe(2);
      expect(result.finalizer.cutoffCount).toBe(1);
    }
  });

  // 1d. Le finalizer lève globalement — journalisé, métriques émises, email pipeline continue.
  it('1d. une exception globale du finalizer est journalisée et le cycle continue sur les emails', async () => {
    let emailExecuted = false;
    const { deps, logger, metrics } = createStubDeps({
      finalizer: async () => {
        throw new Error('SENTINEL_ERR finalizer');
      },
      emailPipeline: async () => {
        emailExecuted = true;
        return {
          claimedCount: 1,
          sentCount: 1,
          failedCount: 0,
          manualReviewCount: 0,
          leaseLostCount: 0,
          anomalies: [],
        };
      },
    });

    const result = await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 5 });

    expect(emailExecuted).toBe(true);
    expect(isPipelineGlobalFailure(result.finalizer!)).toBe(true);

    const serialized = logger.serialized();
    expect(serialized).not.toContain('SENTINEL_ERR');

    const failedEvent = logger.events.find((e) => e.event === 'finalizer_failed');
    expect(failedEvent).toBeDefined();
    if (failedEvent && failedEvent.event === 'finalizer_failed') {
      expect(failedEvent.failureCode).toBe('UNKNOWN_ERROR');
    }

    const snap = metrics.snapshot();
    expect(snap.finalizerFailedTotal['UNKNOWN_ERROR']).toBe(1);
  });

  // 2. Email exécuté même si le pipeline documents lève globalement.
  it('2. exécute le pipeline email même si le pipeline documents lève globalement', async () => {
    let emailExecuted = false;
    const { deps } = createStubDeps({
      docPipeline: async () => {
        throw new Error('Erreur brute du pipeline documents avec SENTINEL_ERR');
      },
      emailPipeline: async () => {
        emailExecuted = true;
        return {
          claimedCount: 1,
          sentCount: 1,
          failedCount: 0,
          manualReviewCount: 0,
          leaseLostCount: 0,
          anomalies: [],
        };
      },
    });

    const result = await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 5 });

    expect(emailExecuted).toBe(true);
    expect(isPipelineGlobalFailure(result.documents)).toBe(true);
    expect(isPipelineGlobalFailure(result.emails)).toBe(false);
  });

  // 2b. Le pipeline email lève globalement — le résultat documentaire n'est pas falsifié.
  it('2b. une exception globale du pipeline email ne falsifie pas le résultat documentaire', async () => {
    const { deps } = createStubDeps({
      docPipeline: async () => ({
        claimedCount: 1,
        completedCount: 3,
        failedCount: 0,
        rescheduledCount: 0,
        leaseLostCount: 0,
        anomalies: [],
      }),
      emailPipeline: async () => {
        throw new Error('Erreur brute du pipeline email');
      },
    });

    const result = await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 5 });

    expect(isPipelineGlobalFailure(result.documents)).toBe(false);
    expect((result.documents as DocumentPipelineResult).completedCount).toBe(3);
    expect(isPipelineGlobalFailure(result.emails)).toBe(true);
  });

  // 3. Résultats agrégés sans mélange.
  it('3. agrège les résultats des deux étapes sans mélange', async () => {
    const { deps } = createStubDeps({
      docPipeline: async () => ({
        claimedCount: 2,
        completedCount: 6,
        failedCount: 1,
        rescheduledCount: 1,
        leaseLostCount: 0,
        anomalies: [
          {
            outboxEventId: 'evt-1',
            effectType: 'GENERATE_CONFIRMATION',
            failureCode: 'RENDER_FAILED',
          },
        ],
      }),
      emailPipeline: async () => ({
        claimedCount: 1,
        sentCount: 1,
        failedCount: 0,
        manualReviewCount: 0,
        leaseLostCount: 0,
        anomalies: [],
      }),
    });

    const result = await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 10 });

    expect(isPipelineGlobalFailure(result.documents)).toBe(false);
    const docResult = result.documents as DocumentPipelineResult;
    expect(docResult.claimedCount).toBe(2);
    expect(docResult.completedCount).toBe(6);

    expect(isPipelineGlobalFailure(result.emails)).toBe(false);
    const emailResult = result.emails as TransactionalEmailPipelineResult;
    expect(emailResult.claimedCount).toBe(1);
    expect(emailResult.sentCount).toBe(1);
  });

  // 4. Normalisation exhaustive des failure codes.
  it('4. normalise les failure codes des anomalies (codes internes → UNKNOWN_ERROR)', async () => {
    const { deps, logger } = createStubDeps({
      docPipeline: async () => ({
        claimedCount: 1,
        completedCount: 0,
        failedCount: 1,
        rescheduledCount: 0,
        leaseLostCount: 0,
        anomalies: [
          {
            outboxEventId: 'evt-1',
            effectType: 'GENERATE_CONFIRMATION',
            failureCode: 'VALIDATION',
          },
          {
            outboxEventId: 'evt-2',
            effectType: 'GENERATE_CONTRACT',
            failureCode: 'SNAPSHOT_INVARIANT',
          },
          {
            outboxEventId: 'evt-3',
            effectType: 'GENERATE_RECEIPT',
            failureCode: 'EVENT_NOT_FOUND',
          },
        ],
      }),
      emailPipeline: async () => ({
        claimedCount: 1,
        sentCount: 0,
        failedCount: 1,
        manualReviewCount: 0,
        leaseLostCount: 0,
        anomalies: [{ outboxEventId: 'evt-4', failureCode: 'EMAIL_IDEMPOTENCY_CONFLICT' }],
      }),
    });

    await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 5 });

    const anomalyEvents = logger.events.filter((e) => e.event === 'anomaly_detected');
    expect(anomalyEvents).toHaveLength(4);
    for (const ev of anomalyEvents) {
      if (ev.event === 'anomaly_detected') {
        expect(ev.failureCode).toBe('UNKNOWN_ERROR');
      }
    }
  });

  it('4b. préserve les failure codes publics tels quels', async () => {
    const { deps, logger } = createStubDeps({
      docPipeline: async () => ({
        claimedCount: 1,
        completedCount: 0,
        failedCount: 1,
        rescheduledCount: 0,
        leaseLostCount: 1,
        anomalies: [
          {
            outboxEventId: 'evt-1',
            effectType: 'GENERATE_CONFIRMATION',
            failureCode: 'STORAGE_CHECKSUM_MISMATCH',
          },
          { outboxEventId: 'evt-2', effectType: 'GENERATE_CONTRACT', failureCode: 'LEASE_LOST' },
        ],
      }),
      emailPipeline: async () => ({
        claimedCount: 1,
        sentCount: 0,
        failedCount: 1,
        manualReviewCount: 0,
        leaseLostCount: 0,
        anomalies: [{ outboxEventId: 'evt-3', failureCode: 'EMAIL_SEND_FAILED' }],
      }),
    });

    await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 5 });

    const anomalyEvents = logger.events.filter((e) => e.event === 'anomaly_detected');
    const codes = anomalyEvents.map((e) => (e as { failureCode: string }).failureCode);
    expect(codes).toContain('STORAGE_CHECKSUM_MISMATCH');
    expect(codes).toContain('LEASE_LOST');
    expect(codes).toContain('EMAIL_SEND_FAILED');
  });

  // 5. Aucune valeur inconnue ou brute dans logs/métriques.
  it('5. ne propage aucune exception brute ou message fournisseur dans les logs', async () => {
    const { deps, logger, metrics } = createStubDeps({
      docPipeline: async () => {
        throw new Error('SENTINEL_ERR brute dans le pipeline documents');
      },
      emailPipeline: async () => {
        throw new Error('SENTINEL_ERR brute dans le pipeline email');
      },
    });

    await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 5 });

    const serialized = logger.serialized();
    // Aucune sentinelle d'erreur brute ne doit apparaître dans les logs.
    expect(serialized).not.toContain('SENTINEL_ERR');
    // Les pipeline_failed doivent contenir uniquement UNKNOWN_ERROR.
    const failedEvents = logger.events.filter((e) => e.event === 'pipeline_failed');
    expect(failedEvents).toHaveLength(2);
    for (const ev of failedEvents) {
      if (ev.event === 'pipeline_failed') {
        expect(ev.failureCode).toBe('UNKNOWN_ERROR');
      }
    }
    // Le snapshot de métriques ne doit pas contenir de sentinelle.
    const metricsSnap = JSON.stringify(metrics.snapshot());
    expect(metricsSnap).not.toContain('SENTINEL_ERR');
  });

  // 6. Labels métriques bornés (pas de UUID/email/storageKey en label).
  it('6. les labels métriques sont strictement bornés', async () => {
    const { deps, metrics } = createStubDeps({
      docPipeline: async () => ({
        claimedCount: 1,
        completedCount: 3,
        failedCount: 0,
        rescheduledCount: 0,
        leaseLostCount: 1,
        anomalies: [
          {
            outboxEventId: '550e8400-e29b-41d4-a716-446655440000',
            effectType: 'GENERATE_CONFIRMATION',
            failureCode: 'RENDER_FAILED',
          },
        ],
      }),
      emailPipeline: async () => ({
        claimedCount: 1,
        sentCount: 1,
        failedCount: 0,
        manualReviewCount: 0,
        leaseLostCount: 0,
        anomalies: [],
      }),
    });

    await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 5 });

    const snap = metrics.snapshot();
    const snapStr = JSON.stringify(snap);
    // Le UUID de l'anomalie ne doit pas apparaître dans le snapshot métriques
    // (les anomalies sont comptées par failureCode, pas par UUID).
    expect(snapStr).not.toContain('550e8400');
    // Les labels de failureCode sont bornés.
    const anomalyKeys = Object.keys(snap.anomaliesTotal.documents);
    const validCodes = new Set<string>([
      'PAYLOAD_MALFORMED',
      'STORAGE_PUT_FAILED',
      'STORAGE_CHECKSUM_MISMATCH',
      'STORAGE_NOT_FOUND',
      'RENDER_FAILED',
      'EMAIL_SEND_FAILED',
      'LEASE_LOST',
      'UNKNOWN_ERROR',
    ]);
    expect(anomalyKeys.every((k) => validCodes.has(k))).toBe(true);
  });

  // 7. Aucune PII admise dans le contrat logger (vérification de type à la compilation).
  it('7. le contrat logger refuse les PII à la compilation', () => {
    // Test de type : tenter de logger un email doit échouer à la compilation.
    // On utilise une fonction helper pour forcer la vérification de type
    // sur l'objet literal complet (excess property check).
    function assertWorkerLogEvent(_ev: WorkerLogEvent): void {}

    assertWorkerLogEvent({
      event: 'cycle_started',
      timestamp: Date.now(),
      // @ts-expect-error — recipientEmail n'est pas un champ autorisé dans CycleStartedEvent.
      recipientEmail: 'user@example.com',
    });
    assertWorkerLogEvent({
      event: 'cycle_completed',
      timestamp: Date.now(),
      outcome: 'success',
      durationMs: 100,
      // @ts-expect-error — providerMessageId n'est pas un champ autorisé dans CycleCompletedEvent.
      providerMessageId: 'msg-123',
    });
  });

  // 8. Erreur de configuration sans valeur d'environnement.
  it('8. createWorkerDependenciesFromEnv lève WorkerConfigurationError sans DATABASE_URL', async () => {
    const originalDbUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(createWorkerDependenciesFromEnv()).rejects.toThrow(WorkerConfigurationError);
      // Vérifier que l'erreur ne contient pas la valeur de DATABASE_URL.
      try {
        await createWorkerDependenciesFromEnv();
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).not.toContain('postgres://');
        expect(msg).not.toContain('postgresql://');
      }
    } finally {
      if (originalDbUrl !== undefined) {
        process.env.DATABASE_URL = originalDbUrl;
      }
    }
  });

  it('8b. createWorkerDependenciesFromEnv lève WorkerConfigurationError même avec DATABASE_URL (fournisseurs non choisis)', async () => {
    const originalDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
    try {
      await expect(createWorkerDependenciesFromEnv()).rejects.toThrow(WorkerConfigurationError);
      try {
        await createWorkerDependenciesFromEnv();
      } catch (e) {
        const msg = (e as Error).message;
        // Ne doit pas afficher l'URL.
        expect(msg).not.toContain('postgresql://localhost:5432/test');
      }
    } finally {
      if (originalDbUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDbUrl;
      }
    }
  });

  // 9. batchLimit invalide rejeté avant traitement.
  it('9. batchLimit=0 est rejeté avant traitement', async () => {
    const { deps, docCallCount, emailCallCount } = createStubDeps();
    await expect(runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 0 })).rejects.toThrow();
    expect(docCallCount()).toBe(0);
    expect(emailCallCount()).toBe(0);
  });

  it('9b. batchLimit négatif est rejeté avant traitement', async () => {
    const { deps, docCallCount } = createStubDeps();
    await expect(runTransactionalDocumentsWorkerCycle(deps, { batchLimit: -1 })).rejects.toThrow();
    expect(docCallCount()).toBe(0);
  });

  it('9c. batchLimit NaN est rejeté avant traitement', async () => {
    const { deps, docCallCount } = createStubDeps();
    await expect(runTransactionalDocumentsWorkerCycle(deps, { batchLimit: NaN })).rejects.toThrow();
    expect(docCallCount()).toBe(0);
  });

  it('9d. batchLimit non-entier est rejeté avant traitement', async () => {
    const { deps, docCallCount } = createStubDeps();
    await expect(runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 3.5 })).rejects.toThrow();
    expect(docCallCount()).toBe(0);
  });

  it('9e. batchLimit > MAX_BATCH_LIMIT est rejeté avant traitement', async () => {
    const { deps, docCallCount } = createStubDeps();
    await expect(runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 11 })).rejects.toThrow();
    expect(docCallCount()).toBe(0);
  });

  // Tests supplémentaires : événements de log attendus.
  it('émet cycle_started et cycle_completed', async () => {
    const { deps, logger } = createStubDeps();
    await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 5 });
    const events = logger.events.map((e) => e.event);
    expect(events[0]).toBe('cycle_started');
    expect(events[events.length - 1]).toBe('cycle_completed');
  });

  it('émet document_pipeline_completed et email_pipeline_completed en cas de succès', async () => {
    const { deps, logger } = createStubDeps();
    await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 5 });
    const events = logger.events.map((e) => e.event);
    expect(events).toContain('document_pipeline_completed');
    expect(events).toContain('email_pipeline_completed');
    expect(events).not.toContain('pipeline_failed');
  });

  it('émet pipeline_failed pour documents en cas d exception globale documents', async () => {
    const { deps, logger } = createStubDeps({
      docPipeline: async () => {
        throw new Error('crash');
      },
    });
    await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 5 });
    const events = logger.events.map((e) => e.event);
    expect(events).toContain('pipeline_failed');
    const failedEvent = logger.events.find(
      (e) => e.event === 'pipeline_failed' && (e as { pipeline: string }).pipeline === 'documents',
    );
    expect(failedEvent).toBeDefined();
  });

  it('cycle_completed a outcome=failed si un pipeline a échoué globalement', async () => {
    const { deps, logger } = createStubDeps({
      docPipeline: async () => {
        throw new Error('crash');
      },
    });
    await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 5 });
    const completedEvent = logger.events.find((e) => e.event === 'cycle_completed');
    expect(completedEvent).toBeDefined();
    if (completedEvent && completedEvent.event === 'cycle_completed') {
      expect(completedEvent.outcome).toBe('failed');
    }
  });

  it('cycle_completed a outcome=success si les deux pipelines ont réussi', async () => {
    const { deps, logger } = createStubDeps();
    await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 5 });
    const completedEvent = logger.events.find((e) => e.event === 'cycle_completed');
    expect(completedEvent).toBeDefined();
    if (completedEvent && completedEvent.event === 'cycle_completed') {
      expect(completedEvent.outcome).toBe('success');
    }
  });

  it('finalizer with inconsistentCount > 0 increments metric and logs cleanly', async () => {
    const { deps, logger, metrics } = createStubDeps({
      finalizer: async () => ({
        inspectedCount: 3,
        finalizedCount: 2,
        cutoffCount: 1,
        uncertainCount: 1,
        inconsistentCount: 1,
      }),
    });

    await runTransactionalDocumentsWorkerCycle(deps, { batchLimit: 5 });

    const completed = logger.events.find((e) => e.event === 'finalizer_completed');
    expect(completed).toBeDefined();
    if (completed && completed.event === 'finalizer_completed') {
      expect(completed.inconsistentCount).toBe(1);
      expect(completed.inspectedCount).toBe(3);
      expect(completed.finalizedCount).toBe(2);
    }

    const snap = metrics.snapshot();
    expect(snap.finalizerInconsistentTotal).toBe(1);
    expect(snap.finalizerFinalizedTotal).toBe(2);
    expect(snap.finalizerCutoffTotal).toBe(1);
    expect(snap.finalizerUncertainTotal).toBe(1);

    const serialized = JSON.stringify(completed);
    const forbidden = /email|recipient|payload|idempotencyKey|providerMessageId|secret/;
    expect(serialized).not.toMatch(forbidden);
  });
});
