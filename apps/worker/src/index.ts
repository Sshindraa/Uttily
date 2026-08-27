/**
 * @uttily/worker — Point d'entrée du worker de documents transactionnels (G5F).
 *
 * Ce module expose une composition injectable et testable :
 * - `runTransactionalDocumentsWorkerCycle` : unité testable (cycle documents puis emails).
 * - `runWorkerCycle` : wrapper minimal qui construit les dépendances par défaut.
 * - `runSweeperCycle` : sweeper/reclaim via le claim existant.
 * - `createWorkerDependenciesFromEnv` : construction depuis l'environnement
 *   (validation fail-fast, création des ressources réelles, shutdown idempotent).
 * - `startWorker` : démarrage production avec gestion SIGTERM/SIGINT et cleanup.
 * - `WorkerConfigurationError` : erreur de configuration normalisée.
 *
 * Exécutable localement : tests unitaires + tests E2E PostgreSQL + harness local
 * (fakes depuis `@uttily/core`).
 *
 * G5H-C2C-B3 : câblage production avec R2, Resend, pdf-lib, PostgreSQL/Neon.
 *
 * Le module n'a AUCUN effet de bord au chargement. Le démarrage de la boucle
 * se fait uniquement quand ce module est le point d'entrée principal
 * (`node dist/index.js`). La fonction `runWorkerLoop` est exportée séparément
 * et couverte par 12 tests unitaires déterministes avec fake timers.
 */

import { createDatabase } from '@uttily/database';
import type { DatabaseClient } from '@uttily/database';
import type { DocumentRenderer, ObjectStorage, TransactionalEmailSender } from '@uttily/core';
import {
  executeDocumentPipeline,
  executeTransactionalEmailPipeline,
  validateOutboxBatchLimit,
} from '@uttily/core';
import { fileURLToPath } from 'node:url';

import type { WorkerDependencies, WorkerCycleOptions } from './worker-cycle.js';
import { runWorkerCycle } from './worker-cycle.js';
import type { WorkerLogger } from './logger.js';
import { ConsoleWorkerLogger } from './logger.js';
import type { WorkerMetricsCollector } from './metrics.js';
import { InMemoryMetricsCollector } from './metrics.js';
import { finalizeEmailDeliveries } from './email-delivery-finalizer.js';
import { PdfLibDocumentRenderer } from './adapters/pdf-lib-document-renderer.js';
import {
  R2ObjectStorage,
  createR2ConfigFromEnv,
  R2ConfigError,
  type R2Config,
} from './adapters/r2-object-storage.js';
import {
  ResendTransactionalEmailSender,
  createResendConfigFromEnv,
  ResendConfigError,
  type ResendConfig,
} from './adapters/resend-transactional-email-sender.js';
import {
  ResendNotificationEmailSender,
  type ResendNotificationConfig,
} from './adapters/resend-notification-email-sender.js';
import type { NotificationEmailSender } from '@uttily/core';
import { FakeNotificationEmailSender } from '@uttily/core';

// ─────────────────────────────────────────────────────────────────────────────
// Erreur de configuration normalisée.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Erreur de configuration du worker. Ne contient JAMAIS de valeur
 * d'environnement, de secret ou de chaîne de connexion.
 */
export class WorkerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerConfigurationError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// createWorkerDependenciesFromEnv — construction depuis l'environnement.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runtime du worker production : dépendances + fonction de shutdown.
 * Le shutdown est async, idempotent et testable.
 */
export interface WorkerRuntime {
  readonly dependencies: WorkerDependencies;
  /** Ferme les ressources (DB, R2). Idempotent. Resend n'a pas de ressource fermable. */
  readonly shutdown: () => Promise<void>;
}

/**
 * Factories de ressources injectables pour testabilité.
 * Les valeurs par défaut construisent les vraies implémentations production.
 */
export interface WorkerResourceFactories {
  readonly createDatabase: (databaseUrl: string) => DatabaseClient;
  readonly createR2Storage: (config: R2Config) => R2ObjectStorage;
  readonly createResendSender: (config: ResendConfig) => ResendTransactionalEmailSender;
  readonly createResendNotificationSender?: (
    config: ResendNotificationConfig,
  ) => ResendNotificationEmailSender;
  readonly createRenderer: () => PdfLibDocumentRenderer;
  readonly createLogger: () => ConsoleWorkerLogger;
  readonly createMetrics: () => InMemoryMetricsCollector;
}

/**
 * Source de signaux injectable. La production utilise `process`.
 * Les tests utilisent une source factice contrôlée.
 */
export interface SignalSource {
  on(signal: 'SIGTERM' | 'SIGINT', listener: () => void): void;
  removeListener(signal: 'SIGTERM' | 'SIGINT', listener: () => void): void;
}

/**
 * Source de signaux par défaut : process.
 */
const processSignalSource: SignalSource = {
  on(signal, listener) {
    process.on(signal, listener);
  },
  removeListener(signal, listener) {
    process.removeListener(signal, listener);
  },
};

/**
 * Factories de ressources par défaut (production).
 */
const defaultResourceFactories: WorkerResourceFactories = {
  createDatabase: (url) => createDatabase(url),
  createR2Storage: (config) => new R2ObjectStorage(config),
  createResendSender: (config) => new ResendTransactionalEmailSender(config),
  createResendNotificationSender: (config) => new ResendNotificationEmailSender(config),
  createRenderer: () => new PdfLibDocumentRenderer(),
  createLogger: () => new ConsoleWorkerLogger(),
  createMetrics: () => new InMemoryMetricsCollector(),
};

/**
 * Options de construction du runtime worker.
 * Permet d'injecter les factories de ressources et l'environnement pour les tests.
 */
export interface CreateWorkerDependenciesOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly factories?: Partial<WorkerResourceFactories>;
}

/**
 * Valide DATABASE_URL sans afficher sa valeur.
 * - chaîne non vide et sans whitespace extérieur ;
 * - URL parseable ;
 * - protocole strictement postgres: ou postgresql: ;
 * - hostname et nom de base non vides.
 */
function validateDatabaseUrl(url: string | undefined): string {
  const label = 'DATABASE_URL';
  if (!url || url.trim() !== url || url.trim() === '') {
    throw new WorkerConfigurationError(
      `${label} est requise et ne doit pas être vide ou contenir des espaces extérieurs.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WorkerConfigurationError(`${label} n est pas une URL valide.`);
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new WorkerConfigurationError(
      `${label} doit utiliser le protocole postgres: ou postgresql:.`,
    );
  }
  if (!parsed.hostname || parsed.hostname.trim() === '') {
    throw new WorkerConfigurationError(`${label} doit contenir un hostname non vide.`);
  }
  const pathname = parsed.pathname;
  if (!pathname || pathname === '/' || pathname.trim() === '') {
    throw new WorkerConfigurationError(`${label} doit contenir un nom de base non vide.`);
  }
  return url;
}

/**
 * Construit les dépendances du worker production depuis l'environnement.
 *
 * Validation fail-fast : toutes les variables requises sont validées AVANT
 * la création de la moindre ressource. Aucun secret, URL, clé ou valeur
 * sensible n'apparaît dans les messages d'erreur.
 *
 * Ordre de validation :
 * 1. DATABASE_URL (format, protocole, hostname, base)
 * 2. R2 (via createR2ConfigFromEnv → validateR2Config)
 * 3. Resend (via createResendConfigFromEnv → validateResendConfig)
 *
 * Ordre de création (après validation complète) :
 * 1. Database (createDatabase)
 * 2. R2ObjectStorage
 * 3. ResendTransactionalEmailSender
 * 4. PdfLibDocumentRenderer
 * 5. ConsoleWorkerLogger
 * 6. InMemoryMetricsCollector
 *
 * Si une factory échoue après que des ressources ont été créées, toutes les
 * ressources déjà ouvertes sont fermées (DB via `end()`, R2 via `close()`).
 * L'environnement et les factories sont injectables pour les tests.
 *
 * @returns WorkerRuntime avec dépendances + shutdown idempotent.
 */
export async function createWorkerDependenciesFromEnv(
  options?: CreateWorkerDependenciesOptions,
): Promise<WorkerRuntime> {
  const env = options?.env ?? process.env;
  const factories = { ...defaultResourceFactories, ...options?.factories };

  // 1. Validation fail-fast — TOUTE la config validée AVANT toute ressource.
  const databaseUrl = validateDatabaseUrl(env.DATABASE_URL);

  let r2Config: R2Config;
  try {
    r2Config = createR2ConfigFromEnv(env);
  } catch (e) {
    throw normalizeConfigError(e, 'configuration R2 invalide');
  }

  let resendConfig: ResendConfig;
  try {
    resendConfig = createResendConfigFromEnv(env);
  } catch (e) {
    throw normalizeConfigError(e, 'configuration Resend invalide');
  }

  // 2. Création des ressources — cleanup en cas d'échec partiel.
  const created: { db?: DatabaseClient; r2?: R2ObjectStorage } = {};
  try {
    created.db = factories.createDatabase(databaseUrl);
    created.r2 = factories.createR2Storage(r2Config);
    const resendSender = factories.createResendSender(resendConfig);
    const notificationSender =
      factories.createResendNotificationSender?.({
        apiKey: resendConfig.apiKey,
        fromEmail: resendConfig.fromEmail,
      }) ??
      new ResendNotificationEmailSender({
        apiKey: resendConfig.apiKey,
        fromEmail: resendConfig.fromEmail,
      });
    const renderer = factories.createRenderer();
    const logger = factories.createLogger();
    const metrics = factories.createMetrics();

    const dependencies: WorkerDependencies = {
      db: created.db,
      renderer,
      storage: created.r2,
      sender: resendSender,
      notificationSender,
      logger,
      metrics,
      executeDocumentPipeline,
      executeTransactionalEmailPipeline,
      executeEmailFinalizer: finalizeEmailDeliveries,
    };

    // 3. Shutdown concurrent idempotent via Promise mémorisée.
    const shutdown = createShutdownFn(created.db, created.r2);

    return { dependencies, shutdown };
  } catch (e) {
    // Cleanup des ressources déjà créées. Tenter tous les cleanups même si l'un échoue.
    const cleanupErrors: string[] = [];
    if (created.db) {
      try {
        await created.db.$client.end();
      } catch {
        cleanupErrors.push('erreur fermeture base de donnees');
      }
    }
    if (created.r2) {
      try {
        created.r2.close();
      } catch {
        cleanupErrors.push('erreur fermeture stockage R2');
      }
    }
    // Journalisation nettoyée des erreurs de cleanup (sans secret ni stack).
    if (cleanupErrors.length > 0) {
      console.error(`Worker: erreurs lors du cleanup partiel (${cleanupErrors.join(', ')}).`);
    }
    // Relancer une WorkerConfigurationError générique et nettoyée.
    throw normalizeConstructionError(e);
  }
}

/**
 * Crée la fonction de shutdown via une Promise mémorisée.
 * Tous les appels concurrents reçoivent la même Promise.
 * DB et R2 ne sont fermés qu'une fois. Toutes les ressources sont tentées.
 */
export function createShutdownFn(db: DatabaseClient, r2: R2ObjectStorage): () => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;
  return () => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        const errors: string[] = [];
        try {
          await db.$client.end();
        } catch {
          errors.push('erreur fermeture base de donnees');
        }
        try {
          r2.close();
        } catch {
          errors.push('erreur fermeture stockage R2');
        }
        if (errors.length > 0) {
          console.error(`Worker: erreurs lors du shutdown (${errors.join(', ')}).`);
        }
      })();
    }
    return shutdownPromise;
  };
}

/**
 * Normalise une erreur de construction de ressource en WorkerConfigurationError
 * sans exposer l'erreur brute, la stack, l'URL ou une valeur sensible.
 */
function normalizeConstructionError(e: unknown): WorkerConfigurationError {
  if (e instanceof WorkerConfigurationError) {
    return e;
  }
  return new WorkerConfigurationError('erreur lors de la construction des ressources du worker.');
}

/**
 * Normalise une erreur de configuration R2/Resend en WorkerConfigurationError
 * sans exposer la valeur sensible d'origine.
 */
function normalizeConfigError(e: unknown, genericMessage: string): WorkerConfigurationError {
  if (e instanceof R2ConfigError || e instanceof ResendConfigError) {
    // Les messages R2/Resend sont déjà nettoyés (pas de secret).
    return new WorkerConfigurationError(e.message);
  }
  return new WorkerConfigurationError(genericMessage);
}

// ─────────────────────────────────────────────────────────────────────────────
// createWorkerDependenciesForTesting — construction pour tests/harness local.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Construit les dépendances du worker pour les tests et le harness local,
 * en utilisant les fakes depuis `@uttily/core`.
 *
 * NE PAS utiliser en production. Les fakes sont autorisés uniquement
 * pour les tests et le harness local.
 */
export function createWorkerDependenciesForTesting(params: {
  db: DatabaseClient;
  renderer: DocumentRenderer;
  storage: ObjectStorage;
  sender: TransactionalEmailSender;
  notificationSender?: NotificationEmailSender;
  logger?: WorkerLogger;
  metrics?: WorkerMetricsCollector;
}): WorkerDependencies {
  return {
    db: params.db,
    renderer: params.renderer,
    storage: params.storage,
    sender: params.sender,
    notificationSender: params.notificationSender ?? new FakeNotificationEmailSender(),
    logger: params.logger ?? new ConsoleWorkerLogger(),
    metrics: params.metrics ?? new InMemoryMetricsCollector(),
    executeDocumentPipeline,
    executeTransactionalEmailPipeline,
    executeEmailFinalizer: finalizeEmailDeliveries,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// runWorkerLoop — boucle de scheduler (couverte par 12 tests unitaires
// déterministes avec fake timers et dépendances mockées).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options de la boucle du worker.
 */
export interface WorkerLoopOptions extends WorkerCycleOptions {
  /** Intervalle entre les cycles en millisecondes. */
  readonly intervalMs: number;
  /** Signal d'arrêt (AbortSignal). La boucle s'arrête quand le signal est aborté. */
  readonly signal?: AbortSignal;
}

/**
 * Boucle de scheduler qui appelle `runWorkerCycle` en boucle avec un intervalle.
 *
 * Cette fonction est couverte par 12 tests unitaires déterministes avec fake
 * timers et dépendances mockées (validation `intervalMs`/`batchLimit`,
 * propagation fatale des erreurs inattendues, arrêt sur signal, retrait de
 * l'listener abort à chaque cycle). Elle est séparée de `runWorkerCycle` pour
 * préserver la testabilité. Elle ne doit JAMAIS être invoquée au module load.
 *
 * La boucle s'arrête quand `signal` est aborté ou quand une erreur non gérée
 * se produit (au niveau de la boucle elle-même, pas des pipelines qui sont
 * isolés).
 */
export async function runWorkerLoop(
  deps: Omit<WorkerDependencies, 'executeDocumentPipeline' | 'executeTransactionalEmailPipeline'>,
  loopOptions: WorkerLoopOptions,
): Promise<void> {
  const { intervalMs, signal, ...cycleOptions } = loopOptions;

  // Valider intervalMs avant l'entrée dans la boucle.
  if (!Number.isInteger(intervalMs) || intervalMs <= 0 || !Number.isFinite(intervalMs)) {
    throw new WorkerConfigurationError('intervalMs doit être un entier fini strictement positif.');
  }

  // Valider batchLimit avant l'entrée dans la boucle (échec rapide sur config invalide).
  // validateOutboxBatchLimit lève une Error si batchLimit est invalide ; on la normalise
  // en WorkerConfigurationError pour cohérence avec le reste de l'API.
  try {
    validateOutboxBatchLimit(cycleOptions.batchLimit);
  } catch {
    throw new WorkerConfigurationError('batchLimit invalide : doit etre un entier entre 1 et 10.');
  }

  while (!signal?.aborted) {
    // runWorkerCycle isole déjà les erreurs document/email (normalisées en
    // PipelineGlobalFailure et journalisées via le logger). Une erreur qui
    // s'échappe de runWorkerCycle est un bug de la boucle elle-même et doit
    // être fatale : on la laisse se propager au lieu de l'avaler sous une
    // étiquette arbitraire.
    await runWorkerCycle(deps, cycleOptions);

    if (signal?.aborted) break;

    // Attendre l'intervalle ou le signal d'arrêt.
    await waitForInterval(intervalMs, signal);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// waitForInterval — attente annulable robuste contre la course AbortSignal.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attend `ms` millisecondes, ou se termine immédiatement si `signal` est aborté.
 *
 * Gère la course où le signal est aborté entre le contrôle initial et
 * l'enregistrement du listener : un second contrôle est effectué après
 * `addEventListener` pour garantir la terminaison immédiate.
 */
async function waitForInterval(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    // Race : si le signal aborte entre le check initial et addEventListener.
    if (signal?.aborted) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports publics.
// ─────────────────────────────────────────────────────────────────────────────

export type {
  WorkerDependencies,
  WorkerCycleOptions,
  WorkerCycleResult,
  DocumentPipelineFn,
  EmailPipelineFn,
  PipelineGlobalFailure,
} from './worker-cycle.js';
export {
  runTransactionalDocumentsWorkerCycle,
  runWorkerCycle,
  isPipelineGlobalFailure,
} from './worker-cycle.js';
export type { SweeperOptions } from './sweeper.js';
export { runSweeperCycle } from './sweeper.js';
export type {
  WorkerLogger,
  PipelineLabel,
  OutcomeLabel,
  WorkerLogEvent,
  CycleStartedEvent,
  DocumentPipelineCompletedEvent,
  EmailPipelineCompletedEvent,
  PipelineFailedEvent,
  AnomalyDetectedEvent,
  CycleCompletedEvent,
} from './logger.js';
export { ConsoleWorkerLogger, CapturingWorkerLogger } from './logger.js';
export type { WorkerMetricsCollector, MetricsSnapshot } from './metrics.js';
export { InMemoryMetricsCollector } from './metrics.js';
export type { WorkerFailureCode } from './failure-codes.js';
export { normalizeFailureCode, WORKER_FAILURE_CODES } from './failure-codes.js';

// G5H-C2C-B2 — Renderer PDF déterministe via pdf-lib.
export { PdfLibDocumentRenderer } from './adapters/pdf-lib-document-renderer.js';
export type { PdfLibTemplateKey } from './adapters/pdf-lib-document-renderer.js';

// G5H-C2C-B3 — Adapters production R2 et Resend.
export {
  R2ObjectStorage,
  R2ConfigError,
  validateR2Config,
  createR2Endpoint,
  createR2ConfigFromEnv,
  createR2ObjectStorageFromEnv,
} from './adapters/r2-object-storage.js';
export type {
  R2Config,
  S3ClientLike,
  R2StorageError,
  R2ErrorCode,
} from './adapters/r2-object-storage.js';
export {
  ResendTransactionalEmailSender,
  ResendConfigError,
  validateResendConfig,
  createResendConfigFromEnv,
  createResendTransactionalEmailSenderFromEnv,
} from './adapters/resend-transactional-email-sender.js';
export type {
  ResendConfig,
  ResendEmailsLike,
  ResendSendPayload,
  ResendSendOptions,
  ResendSendResponse,
  ResendResponseData,
  ResendResponseError,
} from './adapters/resend-transactional-email-sender.js';

// ─────────────────────────────────────────────────────────────────────────────
// Point d'entrée — uniquement si exécuté directement (node dist/index.js).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loop function type for injection.
 */
type RunLoopFn = (
  deps: Omit<WorkerDependencies, 'executeDocumentPipeline' | 'executeTransactionalEmailPipeline'>,
  options: WorkerLoopOptions,
) => Promise<void>;

/**
 * Options de démarrage du worker. Toutes injectables pour les tests.
 */
export interface StartWorkerOptions {
  readonly intervalMs?: number;
  readonly batchLimit?: number;
  readonly signal?: AbortSignal;
  readonly createRuntime?: () => Promise<WorkerRuntime>;
  readonly signalSource?: SignalSource;
  readonly runLoop?: RunLoopFn;
}

/**
 * Démarre le worker production : crée les dépendances, branche les signaux,
 * lance la boucle, et assure le cleanup.
 *
 * Fonction injectable pour tests : accepte des options pour contrôler le
 * comportement sans lancer un vrai processus.
 */
export async function startWorker(options?: StartWorkerOptions): Promise<void> {
  const intervalMs = options?.intervalMs ?? 1000;
  const batchLimit = options?.batchLimit ?? 10;
  const createRuntime = options?.createRuntime ?? createWorkerDependenciesFromEnv;
  const signalSource = options?.signalSource ?? processSignalSource;
  const runLoop = options?.runLoop ?? runWorkerLoop;

  const controller = new AbortController();
  let signalReceived = false;

  const onSignal = () => {
    if (signalReceived) return;
    signalReceived = true;
    controller.abort();
  };

  // Installer les listeners AVANT createRuntime pour qu'un signal reçu
  // pendant la construction asynchrone soit mémorisé.
  signalSource.on('SIGTERM', onSignal);
  signalSource.on('SIGINT', onSignal);

  let runtime: WorkerRuntime;
  try {
    runtime = await createRuntime();
  } catch (e) {
    signalSource.removeListener('SIGTERM', onSignal);
    signalSource.removeListener('SIGINT', onSignal);
    throw e;
  }

  // Si un signal a été reçu pendant createRuntime, ne pas démarrer la boucle normalement.
  if (signalReceived) {
    try {
      await runtime.shutdown();
    } finally {
      signalSource.removeListener('SIGTERM', onSignal);
      signalSource.removeListener('SIGINT', onSignal);
    }
    return;
  }

  // Connecter un signal externe (tests) via un callback nommé.
  let externalOnAbort: (() => void) | null = null;
  if (options?.signal) {
    const externalSignal = options.signal;
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalOnAbort = () => controller.abort();
      externalSignal.addEventListener('abort', externalOnAbort, { once: true });
    }
  }

  try {
    await runLoop(runtime.dependencies, {
      intervalMs,
      batchLimit,
      signal: controller.signal,
    });
  } finally {
    signalSource.removeListener('SIGTERM', onSignal);
    signalSource.removeListener('SIGINT', onSignal);
    if (externalOnAbort && options?.signal) {
      options.signal.removeEventListener('abort', externalOnAbort);
    }
    await runtime.shutdown();
  }
}

// En ESM, vérifier si ce module est le point d'entrée.
const isMainModule = (() => {
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isMainModule) {
  startWorker().catch((e) => {
    if (e instanceof WorkerConfigurationError) {
      console.error(`Worker: configuration invalide — ${e.message}`);
    } else {
      console.error('Worker: erreur inattendue lors du démarrage.');
    }
    process.exitCode = 1;
  });
}
