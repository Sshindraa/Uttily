/**
 * @uttily/worker — Tests unitaires du sweeper (G5F).
 *
 * Le sweeper est une orchestration du cycle existant. Les tests vérifient
 * qu'il délègue correctement à `runTransactionalDocumentsWorkerCycle`.
 */

import { describe, it, expect } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import type { DocumentRenderer, ObjectStorage, TransactionalEmailSender } from '@uttily/core';
import type { DocumentPipelineResult, TransactionalEmailPipelineResult } from '@uttily/core';

import { runSweeperCycle } from './sweeper';
import type { WorkerDependencies } from './worker-cycle';
import { CapturingWorkerLogger } from './logger';
import { InMemoryMetricsCollector } from './metrics';
import type { EmailDeliveryFinalizerResult } from './email-delivery-finalizer';

function createStubDeps(): { deps: WorkerDependencies; logger: CapturingWorkerLogger } {
  const logger = new CapturingWorkerLogger();
  const metrics = new InMemoryMetricsCollector();

  const deps: WorkerDependencies = {
    db: {} as DatabaseClient,
    renderer: {} as DocumentRenderer,
    storage: {} as ObjectStorage,
    sender: {} as TransactionalEmailSender,
    logger,
    metrics,
    executeEmailFinalizer: async () =>
      ({
        inspectedCount: 0,
        finalizedCount: 0,
        cutoffCount: 0,
        uncertainCount: 0,
        inconsistentCount: 0,
      }) as EmailDeliveryFinalizerResult,
    executeDocumentPipeline: async () =>
      ({
        claimedCount: 0,
        completedCount: 0,
        failedCount: 0,
        rescheduledCount: 0,
        leaseLostCount: 0,
        anomalies: [],
      }) as DocumentPipelineResult,
    executeTransactionalEmailPipeline: async () =>
      ({
        claimedCount: 0,
        sentCount: 0,
        failedCount: 0,
        manualReviewCount: 0,
        leaseLostCount: 0,
        anomalies: [],
      }) as TransactionalEmailPipelineResult,
  };

  return { deps, logger };
}

describe('runSweeperCycle', () => {
  it('délègue à runTransactionalDocumentsWorkerCycle (émet cycle_started/cycle_completed)', async () => {
    const { deps, logger } = createStubDeps();
    await runSweeperCycle(deps, { batchLimit: 5 });
    const events = logger.events.map((e) => e.event);
    expect(events[0]).toBe('cycle_started');
    expect(events[events.length - 1]).toBe('cycle_completed');
  });

  it('retourne un résultat agrégé avec documents, finalizer et emails', async () => {
    const { deps } = createStubDeps();
    const result = await runSweeperCycle(deps, { batchLimit: 5 });
    expect(result).toHaveProperty('documents');
    expect(result).toHaveProperty('finalizer');
    expect(result).toHaveProperty('emails');
  });

  it('appelle le finalizer via le cycle', async () => {
    const { deps, logger } = createStubDeps();
    await runSweeperCycle(deps, { batchLimit: 5 });
    const events = logger.events.map((e) => e.event);
    expect(events).toContain('finalizer_completed');
  });

  it('accepte un batchLimit valide', async () => {
    const { deps } = createStubDeps();
    const result = await runSweeperCycle(deps, { batchLimit: 1 });
    expect(result).toBeDefined();
  });

  it('rejette un batchLimit invalide', async () => {
    const { deps } = createStubDeps();
    await expect(runSweeperCycle(deps, { batchLimit: 0 })).rejects.toThrow();
  });
});
