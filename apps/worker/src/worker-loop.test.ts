/**
 * @uttily/worker — Tests unitaires de runWorkerLoop (G5F).
 *
 * Tests déterministes utilisant des fake timers (vi.useFakeTimers) et un mock
 * de `runWorkerCycle` via vi.mock. Aucune DB réelle n'est nécessaire.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import type { DocumentRenderer, ObjectStorage, TransactionalEmailSender } from '@uttily/core';

import { runWorkerCycle } from './worker-cycle.js';
import { runWorkerLoop, WorkerConfigurationError } from './index.js';
import type { WorkerDependencies } from './worker-cycle.js';
import { CapturingWorkerLogger } from './logger.js';
import { InMemoryMetricsCollector } from './metrics.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock de runWorkerCycle pour éviter d'appeler les vrais pipelines.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('./worker-cycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./worker-cycle.js')>();
  return {
    ...actual,
    runWorkerCycle: vi.fn(),
  };
});

const mockRunWorkerCycle = vi.mocked(runWorkerCycle);

// ─────────────────────────────────────────────────────────────────────────────
// Stubs de dépendances minimales.
// ─────────────────────────────────────────────────────────────────────────────

function createStubDeps(): {
  deps: Omit<WorkerDependencies, 'executeDocumentPipeline' | 'executeTransactionalEmailPipeline'>;
  logger: CapturingWorkerLogger;
  metrics: InMemoryMetricsCollector;
} {
  const logger = new CapturingWorkerLogger();
  const metrics = new InMemoryMetricsCollector();
  const deps = {
    db: {} as DatabaseClient,
    renderer: {} as DocumentRenderer,
    storage: {} as ObjectStorage,
    sender: {} as TransactionalEmailSender,
    logger,
    metrics,
  };
  return { deps, logger, metrics };
}

const stubCycleResult = {
  documents: {
    claimedCount: 0,
    completedCount: 0,
    failedCount: 0,
    rescheduledCount: 0,
    leaseLostCount: 0,
    anomalies: [],
  },
  emails: {
    claimedCount: 0,
    sentCount: 0,
    failedCount: 0,
    manualReviewCount: 0,
    leaseLostCount: 0,
    anomalies: [],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests.
// ─────────────────────────────────────────────────────────────────────────────

describe('runWorkerLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRunWorkerCycle.mockReset();
    mockRunWorkerCycle.mockResolvedValue(stubCycleResult);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. intervalMs non entier → WorkerConfigurationError avant la boucle.
  it('1. intervalMs non entier (1.5) → WorkerConfigurationError avant la boucle', async () => {
    const { deps } = createStubDeps();
    await expect(runWorkerLoop(deps, { intervalMs: 1.5, batchLimit: 5 })).rejects.toThrow(
      WorkerConfigurationError,
    );
    expect(mockRunWorkerCycle).not.toHaveBeenCalled();
  });

  // 2. intervalMs = 0 → WorkerConfigurationError.
  it('2. intervalMs = 0 → WorkerConfigurationError', async () => {
    const { deps } = createStubDeps();
    await expect(runWorkerLoop(deps, { intervalMs: 0, batchLimit: 5 })).rejects.toThrow(
      WorkerConfigurationError,
    );
    expect(mockRunWorkerCycle).not.toHaveBeenCalled();
  });

  // 3. intervalMs négatif → WorkerConfigurationError.
  it('3. intervalMs négatif (-100) → WorkerConfigurationError', async () => {
    const { deps } = createStubDeps();
    await expect(runWorkerLoop(deps, { intervalMs: -100, batchLimit: 5 })).rejects.toThrow(
      WorkerConfigurationError,
    );
    expect(mockRunWorkerCycle).not.toHaveBeenCalled();
  });

  // 4. intervalMs = Infinity → WorkerConfigurationError.
  it('4. intervalMs = Infinity → WorkerConfigurationError', async () => {
    const { deps } = createStubDeps();
    await expect(runWorkerLoop(deps, { intervalMs: Infinity, batchLimit: 5 })).rejects.toThrow(
      WorkerConfigurationError,
    );
    expect(mockRunWorkerCycle).not.toHaveBeenCalled();
  });

  // 5. batchLimit invalide → WorkerConfigurationError avant la boucle.
  it('5a. batchLimit = 0 → WorkerConfigurationError avant la boucle', async () => {
    const { deps } = createStubDeps();
    await expect(runWorkerLoop(deps, { intervalMs: 1000, batchLimit: 0 })).rejects.toThrow(
      WorkerConfigurationError,
    );
    expect(mockRunWorkerCycle).not.toHaveBeenCalled();
  });

  it('5b. batchLimit = -1 → WorkerConfigurationError avant la boucle', async () => {
    const { deps } = createStubDeps();
    await expect(runWorkerLoop(deps, { intervalMs: 1000, batchLimit: -1 })).rejects.toThrow(
      WorkerConfigurationError,
    );
    expect(mockRunWorkerCycle).not.toHaveBeenCalled();
  });

  it('5c. batchLimit = NaN → WorkerConfigurationError avant la boucle', async () => {
    const { deps } = createStubDeps();
    await expect(runWorkerLoop(deps, { intervalMs: 1000, batchLimit: NaN })).rejects.toThrow(
      WorkerConfigurationError,
    );
    expect(mockRunWorkerCycle).not.toHaveBeenCalled();
  });

  // 6. AbortSignal déjà aborté arrête la boucle proprement (après 0 cycles).
  it('6. AbortSignal déjà aborté → 0 cycles exécutés', async () => {
    const { deps } = createStubDeps();
    const controller = new AbortController();
    controller.abort();
    await runWorkerLoop(deps, { intervalMs: 1000, batchLimit: 5, signal: controller.signal });
    expect(mockRunWorkerCycle).not.toHaveBeenCalled();
  });

  // 7. AbortSignal arrête la boucle après au moins 1 cycle.
  it('7. AbortSignal arrête la boucle après au moins 1 cycle', async () => {
    const { deps } = createStubDeps();
    const controller = new AbortController();

    // Démarrer la boucle (non awaited car infinie tant que pas aborté).
    const loopPromise = runWorkerLoop(deps, {
      intervalMs: 1000,
      batchLimit: 5,
      signal: controller.signal,
    });

    // Le premier cycle s'exécute immédiatement (await runWorkerCycle).
    await vi.advanceTimersByTimeAsync(0);
    expect(mockRunWorkerCycle).toHaveBeenCalledTimes(1);

    // Aborter pendant l'attente.
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    await loopPromise;
    // Après abort, aucun cycle supplémentaire ne doit s'exécuter.
    expect(mockRunWorkerCycle).toHaveBeenCalledTimes(1);
  });

  // 8. Aucun chevauchement des cycles : le cycle N+1 ne commence pas avant la fin du cycle N.
  it('8. aucun chevauchement des cycles (cycle N+1 après fin du cycle N)', async () => {
    const { deps } = createStubDeps();
    const controller = new AbortController();

    // Cycle contrôlé manuellement via un deferred : on décide quand il se termine.
    let cycleCount = 0;
    let inFlight = false;
    let resolveCurrentCycle: (() => void) | null = null;

    mockRunWorkerCycle.mockImplementation(async () => {
      expect(inFlight).toBe(false); // Pas de chevauchement
      inFlight = true;
      cycleCount++;
      await new Promise<void>((resolve) => {
        resolveCurrentCycle = resolve;
      });
      inFlight = false;
      return stubCycleResult;
    });

    const loopPromise = runWorkerLoop(deps, {
      intervalMs: 1000,
      batchLimit: 5,
      signal: controller.signal,
    });

    // Laisser la boucle démarrer le cycle 1.
    await Promise.resolve();
    await Promise.resolve();
    expect(cycleCount).toBe(1);
    expect(inFlight).toBe(true);

    // Terminer le cycle 1 → la boucle entre dans l'attente d'intervalle (1000ms).
    resolveCurrentCycle!();
    await Promise.resolve();
    await Promise.resolve();
    // Cycle 1 terminé, cycle 2 ne doit pas encore avoir démarré (on est dans l'intervalle).
    expect(cycleCount).toBe(1);
    expect(inFlight).toBe(false);

    // Avancer l'intervalle → cycle 2 démarre.
    await vi.advanceTimersByTimeAsync(1000);
    expect(cycleCount).toBe(2);
    expect(inFlight).toBe(true);

    // Terminer le cycle 2, puis aborter pour terminer la boucle.
    resolveCurrentCycle!();
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await loopPromise;
  });

  // 9. Une erreur inattendue de runWorkerCycle est fatale (propagation).
  // runWorkerCycle isole déjà les erreurs document/email ; une erreur qui
  // s'échappe est un bug de la boucle et ne doit pas être avalée.
  it('9. erreur inattendue de runWorkerCycle → fatal (propagation)', async () => {
    const { deps, logger } = createStubDeps();
    const controller = new AbortController();

    mockRunWorkerCycle.mockRejectedValueOnce(new Error('bug de boucle'));

    const loopPromise = runWorkerLoop(deps, {
      intervalMs: 1000,
      batchLimit: 5,
      signal: controller.signal,
    });

    // Attacher le handler de rejet avant de flusher les microtasks pour éviter
    // une unhandled rejection.
    const assertion = expect(loopPromise).rejects.toThrow('bug de boucle');

    // Le premier cycle lève une erreur → propagation fatale (pas de journalisation
    // sous une étiquette arbitraire, pas d'avalage).
    await vi.advanceTimersByTimeAsync(0);
    await assertion;

    // Aucun pipeline_failed ne doit être émis par la boucle (l'isolation est
    // du ressort de runWorkerCycle, pas de la boucle).
    const pipelineFailedEvents = logger.events.filter((e) => e.event === 'pipeline_failed');
    expect(pipelineFailedEvents).toHaveLength(0);
  });

  // 10b. erreur inattendue de runWorkerCycle → fatal (propagation), sans signal.
  it('10b. erreur inattendue de runWorkerCycle → fatal (propagation)', async () => {
    const { deps } = createStubDeps();
    mockRunWorkerCycle.mockRejectedValueOnce(new Error('unexpected'));
    await expect(runWorkerLoop(deps, { intervalMs: 1000, batchLimit: 5 })).rejects.toThrow(
      'unexpected',
    );
  });
});
