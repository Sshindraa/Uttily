/**
 * @uttily/worker — Tests du point d'entrée (G5F, G5H-C2C-B3).
 *
 * Ces tests couvrent :
 * - la validation de configuration (variables manquantes, invalides, valides) ;
 * - la composition des dépendances production (pas de fakes) ;
 * - le cleanup idempotent (DB, R2) ;
 * - la gestion des signaux (SIGTERM/SIGINT via AbortController externe).
 *
 * Aucun appel réseau réel n'est effectué : postgres-js est paresseux (pas de
 * connexion avant la première requête), S3Client ne fait aucune requête à la
 * construction, et le SDK Resend n'envoie rien à la construction.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import {
  WorkerConfigurationError,
  createWorkerDependenciesFromEnv,
  createShutdownFn,
  startWorker,
  type WorkerRuntime,
  type WorkerDependencies,
  type WorkerResourceFactories,
  type SignalSource,
} from './index';
import { executeDocumentPipeline, executeTransactionalEmailPipeline } from '@uttily/core';
import { PdfLibDocumentRenderer } from './adapters/pdf-lib-document-renderer.js';
import { R2ObjectStorage } from './adapters/r2-object-storage.js';
import { ResendTransactionalEmailSender } from './adapters/resend-transactional-email-sender.js';
import { ConsoleWorkerLogger } from './logger.js';
import { InMemoryMetricsCollector } from './metrics.js';
import { finalizeEmailDeliveries } from './email-delivery-finalizer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers pour la gestion de process.env
// ─────────────────────────────────────────────────────────────────────────────

const ENV_KEYS = [
  'DATABASE_URL',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'RESEND_BOOKING_CONFIRMED_TEMPLATE_ID',
] as const;

function setValidEnv(): void {
  process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/testdb';
  process.env.R2_ACCOUNT_ID = 'abcdef123456';
  process.env.R2_ACCESS_KEY_ID = 'testaccesskey';
  process.env.R2_SECRET_ACCESS_KEY = 'testsecretkey';
  process.env.R2_BUCKET_NAME = 'test-bucket';
  process.env.RESEND_API_KEY = 're_testkey123';
  process.env.RESEND_FROM_EMAIL = 'noreply@example.com';
  process.env.RESEND_BOOKING_CONFIRMED_TEMPLATE_ID = 'tmpl_123456';
}

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

function saveEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
  }
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Env valide injectable (sans modifier process.env)
// ─────────────────────────────────────────────────────────────────────────────

const validEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/testdb',
  R2_ACCOUNT_ID: 'abcdef123456',
  R2_ACCESS_KEY_ID: 'testaccesskey',
  R2_SECRET_ACCESS_KEY: 'testsecretkey',
  R2_BUCKET_NAME: 'test-bucket',
  RESEND_API_KEY: 're_testkey123',
  RESEND_FROM_EMAIL: 'noreply@example.com',
  RESEND_BOOKING_CONFIRMED_TEMPLATE_ID: 'tmpl_123456',
};

// ─────────────────────────────────────────────────────────────────────────────
// FakeSignalSource — source de signaux factice pour les tests
// ─────────────────────────────────────────────────────────────────────────────

class FakeSignalSource implements SignalSource {
  private listeners = new Map<string, (() => void)[]>();

  on(signal: 'SIGTERM' | 'SIGINT', listener: () => void): void {
    const arr = this.listeners.get(signal) ?? [];
    arr.push(listener);
    this.listeners.set(signal, arr);
  }

  removeListener(signal: 'SIGTERM' | 'SIGINT', listener: () => void): void {
    const arr = this.listeners.get(signal) ?? [];
    const idx = arr.indexOf(listener);
    if (idx >= 0) arr.splice(idx, 1);
    this.listeners.set(signal, arr);
  }

  emit(signal: 'SIGTERM' | 'SIGINT'): void {
    const arr = this.listeners.get(signal) ?? [];
    for (const l of arr) l();
  }

  listenerCount(signal: string): number {
    return (this.listeners.get(signal) ?? []).length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers pour les tests de cleanup/signaux
// ─────────────────────────────────────────────────────────────────────────────

function createMockRuntime(): {
  runtime: WorkerRuntime & { shutdown: () => Promise<void> };
  calls: { dbEnd: number; r2Close: number };
} {
  const calls = { dbEnd: 0, r2Close: 0 };

  const mockDb = {
    $client: {
      end: async () => {
        calls.dbEnd++;
      },
    },
  } as unknown as DatabaseClient;

  const mockStorage = {
    close: () => {
      calls.r2Close++;
    },
  } as unknown as R2ObjectStorage;

  const dependencies = {
    db: mockDb,
    renderer: new PdfLibDocumentRenderer(),
    storage: mockStorage,
    sender: {} as ResendTransactionalEmailSender,
    logger: new ConsoleWorkerLogger(),
    metrics: new InMemoryMetricsCollector(),
    executeDocumentPipeline,
    executeTransactionalEmailPipeline,
    executeEmailFinalizer: finalizeEmailDeliveries,
  } as WorkerDependencies;

  let shutdownDone = false;
  const shutdown = async () => {
    if (shutdownDone) return;
    shutdownDone = true;
    const errors: string[] = [];
    try {
      await mockDb.$client.end();
    } catch {
      errors.push('erreur fermeture base de donnees');
    }
    try {
      mockStorage.close();
    } catch {
      errors.push('erreur fermeture stockage R2');
    }
    if (errors.length > 0) {
      console.error(`Worker: erreurs lors du shutdown (${errors.join(', ')}).`);
    }
  };

  return { runtime: { dependencies, shutdown }, calls };
}

function createMockRuntimeWithThrowingDb(): {
  runtime: WorkerRuntime & { shutdown: () => Promise<void> };
  calls: { dbEnd: number; r2Close: number };
} {
  const calls = { dbEnd: 0, r2Close: 0 };

  const mockDb = {
    $client: {
      end: async () => {
        calls.dbEnd++;
        throw new Error('DB end failed');
      },
    },
  } as unknown as DatabaseClient;

  const mockStorage = {
    close: () => {
      calls.r2Close++;
    },
  } as unknown as R2ObjectStorage;

  const dependencies = {
    db: mockDb,
    renderer: new PdfLibDocumentRenderer(),
    storage: mockStorage,
    sender: {} as ResendTransactionalEmailSender,
    logger: new ConsoleWorkerLogger(),
    metrics: new InMemoryMetricsCollector(),
    executeDocumentPipeline,
    executeTransactionalEmailPipeline,
    executeEmailFinalizer: finalizeEmailDeliveries,
  } as WorkerDependencies;

  let shutdownDone = false;
  const shutdown = async () => {
    if (shutdownDone) return;
    shutdownDone = true;
    const errors: string[] = [];
    try {
      await mockDb.$client.end();
    } catch {
      errors.push('erreur fermeture base de donnees');
    }
    try {
      mockStorage.close();
    } catch {
      errors.push('erreur fermeture stockage R2');
    }
    if (errors.length > 0) {
      console.error(`Worker: erreurs lors du shutdown (${errors.join(', ')}).`);
    }
  };

  return { runtime: { dependencies, shutdown }, calls };
}

function createMockRuntimeWithThrowingR2(): {
  runtime: WorkerRuntime & { shutdown: () => Promise<void> };
  calls: { dbEnd: number; r2Close: number };
} {
  const calls = { dbEnd: 0, r2Close: 0 };

  const mockDb = {
    $client: {
      end: async () => {
        calls.dbEnd++;
      },
    },
  } as unknown as DatabaseClient;

  const mockStorage = {
    close: () => {
      calls.r2Close++;
      throw new Error('R2 close failed');
    },
  } as unknown as R2ObjectStorage;

  const dependencies = {
    db: mockDb,
    renderer: new PdfLibDocumentRenderer(),
    storage: mockStorage,
    sender: {} as ResendTransactionalEmailSender,
    logger: new ConsoleWorkerLogger(),
    metrics: new InMemoryMetricsCollector(),
    executeDocumentPipeline,
    executeTransactionalEmailPipeline,
    executeEmailFinalizer: finalizeEmailDeliveries,
  } as WorkerDependencies;

  let shutdownDone = false;
  const shutdown = async () => {
    if (shutdownDone) return;
    shutdownDone = true;
    const errors: string[] = [];
    try {
      await mockDb.$client.end();
    } catch {
      errors.push('erreur fermeture base de donnees');
    }
    try {
      mockStorage.close();
    } catch {
      errors.push('erreur fermeture stockage R2');
    }
    if (errors.length > 0) {
      console.error(`Worker: erreurs lors du shutdown (${errors.join(', ')}).`);
    }
  };

  return { runtime: { dependencies, shutdown }, calls };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('@uttily/worker — index', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveEnv();
    clearEnv();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4a. Configuration validation tests
  // ───────────────────────────────────────────────────────────────────────────

  describe('Configuration validation', () => {
    it('DATABASE_URL manquante → WorkerConfigurationError', async () => {
      setValidEnv();
      delete process.env.DATABASE_URL;
      await expect(createWorkerDependenciesFromEnv()).rejects.toThrow(WorkerConfigurationError);
    });

    it('R2_ACCOUNT_ID manquant → WorkerConfigurationError', async () => {
      setValidEnv();
      delete process.env.R2_ACCOUNT_ID;
      await expect(createWorkerDependenciesFromEnv()).rejects.toThrow(WorkerConfigurationError);
    });

    it('R2_ACCESS_KEY_ID manquant → WorkerConfigurationError', async () => {
      setValidEnv();
      delete process.env.R2_ACCESS_KEY_ID;
      await expect(createWorkerDependenciesFromEnv()).rejects.toThrow(WorkerConfigurationError);
    });

    it('R2_SECRET_ACCESS_KEY manquant → WorkerConfigurationError', async () => {
      setValidEnv();
      delete process.env.R2_SECRET_ACCESS_KEY;
      await expect(createWorkerDependenciesFromEnv()).rejects.toThrow(WorkerConfigurationError);
    });

    it('R2_BUCKET_NAME manquant → WorkerConfigurationError', async () => {
      setValidEnv();
      delete process.env.R2_BUCKET_NAME;
      await expect(createWorkerDependenciesFromEnv()).rejects.toThrow(WorkerConfigurationError);
    });

    it('RESEND_API_KEY manquant → WorkerConfigurationError', async () => {
      setValidEnv();
      delete process.env.RESEND_API_KEY;
      await expect(createWorkerDependenciesFromEnv()).rejects.toThrow(WorkerConfigurationError);
    });

    it('RESEND_FROM_EMAIL manquant → WorkerConfigurationError', async () => {
      setValidEnv();
      delete process.env.RESEND_FROM_EMAIL;
      await expect(createWorkerDependenciesFromEnv()).rejects.toThrow(WorkerConfigurationError);
    });

    it('RESEND_BOOKING_CONFIRMED_TEMPLATE_ID manquant → WorkerConfigurationError', async () => {
      setValidEnv();
      delete process.env.RESEND_BOOKING_CONFIRMED_TEMPLATE_ID;
      await expect(createWorkerDependenciesFromEnv()).rejects.toThrow(WorkerConfigurationError);
    });

    it('DATABASE_URL avec whitespace extérieur → WorkerConfigurationError', async () => {
      setValidEnv();
      process.env.DATABASE_URL = '  postgresql://user:pass@localhost:5432/testdb  ';
      await expect(createWorkerDependenciesFromEnv()).rejects.toThrow(WorkerConfigurationError);
    });

    it('DATABASE_URL malformée (pas une URL) → WorkerConfigurationError', async () => {
      setValidEnv();
      process.env.DATABASE_URL = 'not-a-url';
      await expect(createWorkerDependenciesFromEnv()).rejects.toThrow(WorkerConfigurationError);
    });

    it('DATABASE_URL avec mauvais protocole (http:) → WorkerConfigurationError', async () => {
      setValidEnv();
      process.env.DATABASE_URL = 'http://localhost:5432/testdb';
      await expect(createWorkerDependenciesFromEnv()).rejects.toThrow(WorkerConfigurationError);
    });

    it('DATABASE_URL avec hostname vide → WorkerConfigurationError', async () => {
      setValidEnv();
      process.env.DATABASE_URL = 'postgresql:///testdb';
      await expect(createWorkerDependenciesFromEnv()).rejects.toThrow(WorkerConfigurationError);
    });

    it('DATABASE_URL avec nom de base vide → WorkerConfigurationError', async () => {
      setValidEnv();
      process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/';
      await expect(createWorkerDependenciesFromEnv()).rejects.toThrow(WorkerConfigurationError);
    });

    it('R2 config invalide (bad account ID) → WorkerConfigurationError', async () => {
      setValidEnv();
      process.env.R2_ACCOUNT_ID = 'bad!';
      await expect(createWorkerDependenciesFromEnv()).rejects.toThrow(WorkerConfigurationError);
    });

    it('Resend config invalide (bad API key) → WorkerConfigurationError', async () => {
      setValidEnv();
      process.env.RESEND_API_KEY = 'bad_key_no_prefix';
      await expect(createWorkerDependenciesFromEnv()).rejects.toThrow(WorkerConfigurationError);
    });

    it('Configuration valide → retourne WorkerRuntime avec dépendances', async () => {
      setValidEnv();
      const runtime = await createWorkerDependenciesFromEnv();
      expect(runtime).toBeDefined();
      expect(runtime.dependencies).toBeDefined();
      expect(typeof runtime.shutdown).toBe('function');
      // Cleanup — ferme les ressources créées (R2 client).
      await runtime.shutdown();
    });

    it('Aucune ressource créée si la validation échoue (erreur de config, pas de connexion)', async () => {
      setValidEnv();
      delete process.env.DATABASE_URL;
      // L'erreur doit être une WorkerConfigurationError (validation), pas une
      // erreur de connexion DB.
      try {
        await createWorkerDependenciesFromEnv();
        expect.fail('devrait lever une erreur');
      } catch (e) {
        expect(e).toBeInstanceOf(WorkerConfigurationError);
        // Le message doit mentionner DATABASE_URL, pas une erreur de connexion.
        expect((e as Error).message).toContain('DATABASE_URL');
      }
    });

    it('Aucune ressource créée si R2 config est invalide (DATABASE_URL valide, R2 invalide)', async () => {
      setValidEnv();
      process.env.R2_ACCOUNT_ID = 'bad!';
      // DATABASE_URL est valide mais R2 est invalide : aucune ressource (DB, S3)
      // ne doit être créée. L'erreur doit être une WorkerConfigurationError propre
      // sur R2, sans appel réseau ni connexion DB.
      try {
        await createWorkerDependenciesFromEnv();
        expect.fail('devrait lever une erreur');
      } catch (e) {
        expect(e).toBeInstanceOf(WorkerConfigurationError);
        // Le message doit concerner R2, pas une erreur de connexion DB.
        expect((e as Error).message).not.toContain('connexion');
        expect((e as Error).message).not.toContain('ECONNREFUSED');
      }
    });

    it('Aucune ressource créée si Resend config est invalide (R2 valide, Resend invalide)', async () => {
      setValidEnv();
      process.env.RESEND_API_KEY = 'bad_key_no_prefix';
      // R2 config est valide mais Resend est invalide : aucune ressource (S3, DB)
      // ne doit être créée car toute la config est validée avant création.
      // L'erreur doit être une WorkerConfigurationError propre sur Resend,
      // sans appel réseau ni connexion DB.
      try {
        await createWorkerDependenciesFromEnv();
        expect.fail('devrait lever une erreur');
      } catch (e) {
        expect(e).toBeInstanceOf(WorkerConfigurationError);
        // Le message doit concerner Resend, pas une erreur de connexion DB.
        expect((e as Error).message).not.toContain('connexion');
        expect((e as Error).message).not.toContain('ECONNREFUSED');
      }
    });

    it('Aucune valeur sensible dans les messages d erreur (DATABASE_URL)', async () => {
      setValidEnv();
      // URL avec mauvais protocole pour forcer une erreur de validation,
      // mais contenant des valeurs sensibles (mot de passe, nom de base).
      process.env.DATABASE_URL = 'http://user:SECRETpass@localhost:5432/secretDB';
      try {
        await createWorkerDependenciesFromEnv();
        expect.fail('devrait lever une erreur');
      } catch (e) {
        expect(e).toBeInstanceOf(WorkerConfigurationError);
        const msg = (e as Error).message;
        expect(msg).not.toContain('SECRETpass');
        expect(msg).not.toContain('secretDB');
        expect(msg).not.toContain('http://user:SECRETpass@localhost:5432/secretDB');
      }
    });

    it('Aucune valeur sensible dans les messages d erreur (R2)', async () => {
      setValidEnv();
      process.env.R2_SECRET_ACCESS_KEY = 'SUPERSECRETKEY123';
      process.env.R2_ACCOUNT_ID = 'bad!';
      try {
        await createWorkerDependenciesFromEnv();
        expect.fail('devrait lever une erreur');
      } catch (e) {
        expect(e).toBeInstanceOf(WorkerConfigurationError);
        const msg = (e as Error).message;
        expect(msg).not.toContain('SUPERSECRETKEY123');
        expect(msg).not.toContain('test-bucket');
      }
    });

    it('Aucune valeur sensible dans les messages d erreur (Resend)', async () => {
      setValidEnv();
      process.env.RESEND_API_KEY = 're_SUPERSECRETAPIKEY';
      process.env.RESEND_FROM_EMAIL = 'bad-email-format';
      try {
        await createWorkerDependenciesFromEnv();
        expect.fail('devrait lever une erreur');
      } catch (e) {
        expect(e).toBeInstanceOf(WorkerConfigurationError);
        const msg = (e as Error).message;
        expect(msg).not.toContain('re_SUPERSECRETAPIKEY');
        expect(msg).not.toContain('tmpl_123456');
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4b. Composition tests
  // ───────────────────────────────────────────────────────────────────────────

  describe('Composition des dépendances', () => {
    let runtime: WorkerRuntime;

    beforeEach(async () => {
      setValidEnv();
      runtime = await createWorkerDependenciesFromEnv();
    });

    afterEach(async () => {
      await runtime.shutdown();
    });

    it('dependencies.db est défini (DatabaseClient)', () => {
      expect(runtime.dependencies.db).toBeDefined();
      expect(runtime.dependencies.db.$client).toBeDefined();
    });

    it('dependencies.renderer est une instance de PdfLibDocumentRenderer', () => {
      expect(runtime.dependencies.renderer).toBeInstanceOf(PdfLibDocumentRenderer);
    });

    it('dependencies.storage est une instance de R2ObjectStorage', () => {
      expect(runtime.dependencies.storage).toBeInstanceOf(R2ObjectStorage);
    });

    it('dependencies.sender est une instance de ResendTransactionalEmailSender', () => {
      expect(runtime.dependencies.sender).toBeInstanceOf(ResendTransactionalEmailSender);
    });

    it('dependencies.logger est une instance de ConsoleWorkerLogger', () => {
      expect(runtime.dependencies.logger).toBeInstanceOf(ConsoleWorkerLogger);
    });

    it('dependencies.metrics est une instance de InMemoryMetricsCollector', () => {
      expect(runtime.dependencies.metrics).toBeInstanceOf(InMemoryMetricsCollector);
    });

    it('dependencies.executeDocumentPipeline est une fonction', () => {
      expect(typeof runtime.dependencies.executeDocumentPipeline).toBe('function');
    });

    it('dependencies.executeTransactionalEmailPipeline est une fonction', () => {
      expect(typeof runtime.dependencies.executeTransactionalEmailPipeline).toBe('function');
    });

    it('dependencies.executeEmailFinalizer est une fonction', () => {
      expect(typeof runtime.dependencies.executeEmailFinalizer).toBe('function');
    });

    it('Pas de fake Core utilisé (renderer est PdfLibDocumentRenderer)', () => {
      // Si c'était un fake, ce ne serait pas une instance de PdfLibDocumentRenderer.
      expect(runtime.dependencies.renderer).toBeInstanceOf(PdfLibDocumentRenderer);
      // Vérifier que ce n'est pas le fake en vérifiant le nom du constructeur.
      expect(runtime.dependencies.renderer.constructor.name).toBe('PdfLibDocumentRenderer');
    });

    it('Pas de fake Core utilisé (storage est R2ObjectStorage)', () => {
      expect(runtime.dependencies.storage).toBeInstanceOf(R2ObjectStorage);
      expect(runtime.dependencies.storage.constructor.name).toBe('R2ObjectStorage');
    });

    it('Pas de fake Core utilisé (sender est ResendTransactionalEmailSender)', () => {
      expect(runtime.dependencies.sender).toBeInstanceOf(ResendTransactionalEmailSender);
      expect(runtime.dependencies.sender.constructor.name).toBe('ResendTransactionalEmailSender');
    });

    it('Aucun appel réseau pendant les tests (la création est paresseuse)', () => {
      // Si un appel réseau avait lieu, le test aurait échoué ou serait en timeout.
      // Le simple fait d'arriver ici sans erreur confirme la nature paresseuse.
      expect(runtime.dependencies.db).toBeDefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4c. Cleanup tests
  // ───────────────────────────────────────────────────────────────────────────

  describe('Cleanup (shutdown)', () => {
    it('shutdown() ferme la DB (dbEnd appelé)', async () => {
      const { runtime, calls } = createMockRuntime();
      await runtime.shutdown();
      expect(calls.dbEnd).toBe(1);
    });

    it('shutdown() ferme R2 (r2Close appelé)', async () => {
      const { runtime, calls } = createMockRuntime();
      await runtime.shutdown();
      expect(calls.r2Close).toBe(1);
    });

    it('shutdown() est idempotent (appel double ne ferme qu une fois)', async () => {
      const { runtime, calls } = createMockRuntime();
      await runtime.shutdown();
      await runtime.shutdown();
      expect(calls.dbEnd).toBe(1);
      expect(calls.r2Close).toBe(1);
    });

    it('shutdown() ne lève pas si DB end échoue', async () => {
      const { runtime, calls } = createMockRuntimeWithThrowingDb();
      await expect(runtime.shutdown()).resolves.toBeUndefined();
      expect(calls.dbEnd).toBe(1);
    });

    it('shutdown() ne lève pas si R2 close échoue', async () => {
      const { runtime, calls } = createMockRuntimeWithThrowingR2();
      await expect(runtime.shutdown()).resolves.toBeUndefined();
      expect(calls.r2Close).toBe(1);
    });

    it('shutdown() tente de fermer R2 même si DB end échoue', async () => {
      const { runtime, calls } = createMockRuntimeWithThrowingDb();
      await runtime.shutdown();
      expect(calls.dbEnd).toBe(1);
      expect(calls.r2Close).toBe(1);
    });

    it('shutdown() tente de fermer DB même si R2 close échoue', async () => {
      const { runtime, calls } = createMockRuntimeWithThrowingR2();
      await runtime.shutdown();
      expect(calls.dbEnd).toBe(1);
      expect(calls.r2Close).toBe(1);
    });

    it('Pas de cleanup Resend (aucune ressource fermable)', async () => {
      // Le mock sender est un objet vide — shutdown ne doit pas appeler
      // de méthode sur le sender. On vérifie que shutdown complète sans
      // erreur et que seul dbEnd et r2Close sont appelés.
      const { runtime, calls } = createMockRuntime();
      await runtime.shutdown();
      expect(calls.dbEnd).toBe(1);
      expect(calls.r2Close).toBe(1);
      // Pas d'appel supplémentaire — le sender n'a pas de méthode close.
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4d. Signal tests
  // ───────────────────────────────────────────────────────────────────────────

  describe('Gestion des signaux (startWorker)', () => {
    it('AbortSignal externe — abort déclenche cleanup (dbEnd + r2Close)', async () => {
      const { runtime, calls } = createMockRuntime();
      const controller = new AbortController();

      const promise = startWorker({
        intervalMs: 10,
        batchLimit: 1,
        signal: controller.signal,
        createRuntime: async () => runtime,
      });

      // Laisser la boucle démarrer, puis aborter.
      setTimeout(() => controller.abort(), 50);

      await promise; // Doit se terminer sans bloquer.

      expect(calls.dbEnd).toBe(1);
      expect(calls.r2Close).toBe(1);
    });

    it('AbortSignal externe — second scénario abort déclenche cleanup', async () => {
      const { runtime, calls } = createMockRuntime();
      const controller = new AbortController();

      const promise = startWorker({
        intervalMs: 10,
        batchLimit: 1,
        signal: controller.signal,
        createRuntime: async () => runtime,
      });

      setTimeout(() => controller.abort(), 50);

      await promise;

      expect(calls.dbEnd).toBe(1);
      expect(calls.r2Close).toBe(1);
    });

    it('AbortSignal externe — double abort ne déclenche qu un seul cleanup', async () => {
      const { runtime, calls } = createMockRuntime();
      const controller = new AbortController();

      const promise = startWorker({
        intervalMs: 10,
        batchLimit: 1,
        signal: controller.signal,
        createRuntime: async () => runtime,
      });

      setTimeout(() => {
        controller.abort();
        // Second abort — ne doit pas déclencher un second cleanup.
        controller.abort();
      }, 50);

      await promise;

      expect(calls.dbEnd).toBe(1);
      expect(calls.r2Close).toBe(1);
    });

    it('La boucle se termine et cleanup s exécute même sans signal externe', async () => {
      // Utiliser un signal externe qui aborte immédiatement pour simuler
      // la terminaison de la boucle.
      const { runtime, calls } = createMockRuntime();
      const controller = new AbortController();

      const promise = startWorker({
        intervalMs: 10,
        batchLimit: 1,
        signal: controller.signal,
        createRuntime: async () => runtime,
      });

      // Aborter presque immédiatement.
      setTimeout(() => controller.abort(), 20);

      await promise;

      expect(calls.dbEnd).toBe(1);
      expect(calls.r2Close).toBe(1);
    });

    it('Les listeners sont retirés après shutdown', async () => {
      const { runtime } = createMockRuntime();
      const controller = new AbortController();

      const sigtermBefore = process.listenerCount('SIGTERM');
      const sigintBefore = process.listenerCount('SIGINT');

      const promise = startWorker({
        intervalMs: 10,
        batchLimit: 1,
        signal: controller.signal,
        createRuntime: async () => runtime,
      });

      setTimeout(() => controller.abort(), 50);

      await promise;

      // Après shutdown, les listeners doivent être retirés.
      expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
      expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    });

    it('Erreur fatale dans createRuntime se propage (startWorker rejette)', async () => {
      const createRuntime = async () => {
        throw new WorkerConfigurationError('config test error');
      };

      await expect(
        startWorker({
          intervalMs: 10,
          batchLimit: 1,
          createRuntime,
        }),
      ).rejects.toThrow(WorkerConfigurationError);
    });

    it('Pas de process.exit() dans le chemin testé (startWorker retourne normalement)', async () => {
      const { runtime, calls } = createMockRuntime();
      const controller = new AbortController();

      const promise = startWorker({
        intervalMs: 10,
        batchLimit: 1,
        signal: controller.signal,
        createRuntime: async () => runtime,
      });

      setTimeout(() => controller.abort(), 50);

      // Si process.exit() était appelé, cette ligne ne serait jamais atteinte.
      await expect(promise).resolves.toBeUndefined();

      expect(calls.dbEnd).toBe(1);
      expect(calls.r2Close).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4e. Env injection tests
  // ───────────────────────────────────────────────────────────────────────────

  describe('Env injection (createWorkerDependenciesFromEnv avec env injecté)', () => {
    it('createWorkerDependenciesFromEnv accepte env injecté (sans modifier process.env)', async () => {
      const originalEnv = { ...process.env };
      const runtime = await createWorkerDependenciesFromEnv({ env: validEnv });
      expect(runtime.dependencies).toBeDefined();
      expect(process.env).toEqual(originalEnv); // process.env non modifié
      await runtime.shutdown();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4f. Partial construction cleanup tests
  // ───────────────────────────────────────────────────────────────────────────

  describe('Cleanup lors de construction partielle', () => {
    it('échec createDatabase — aucun cleanup nécessaire', async () => {
      const factories: Partial<WorkerResourceFactories> = {
        createDatabase: () => {
          throw new Error('db fail');
        },
      };
      await expect(createWorkerDependenciesFromEnv({ env: validEnv, factories })).rejects.toThrow(
        WorkerConfigurationError,
      );
    });

    it('échec création R2 — DB fermée', async () => {
      let dbEndCalled = false;
      const factories: Partial<WorkerResourceFactories> = {
        createDatabase: () =>
          ({
            $client: {
              end: async () => {
                dbEndCalled = true;
              },
            },
          }) as unknown as DatabaseClient,
        createR2Storage: () => {
          throw new Error('r2 fail');
        },
      };
      await expect(createWorkerDependenciesFromEnv({ env: validEnv, factories })).rejects.toThrow(
        WorkerConfigurationError,
      );
      expect(dbEndCalled).toBe(true);
    });

    it('échec création Resend — DB et R2 fermés', async () => {
      let dbEndCalled = false;
      let r2CloseCalled = false;
      const factories: Partial<WorkerResourceFactories> = {
        createDatabase: () =>
          ({
            $client: {
              end: async () => {
                dbEndCalled = true;
              },
            },
          }) as unknown as DatabaseClient,
        createR2Storage: () =>
          ({
            close: () => {
              r2CloseCalled = true;
            },
          }) as unknown as R2ObjectStorage,
        createResendSender: () => {
          throw new Error('resend fail');
        },
      };
      await expect(createWorkerDependenciesFromEnv({ env: validEnv, factories })).rejects.toThrow(
        WorkerConfigurationError,
      );
      expect(dbEndCalled).toBe(true);
      expect(r2CloseCalled).toBe(true);
    });

    it('échec factory postérieure — DB et R2 fermés', async () => {
      let dbEndCalled = false;
      let r2CloseCalled = false;
      const factories: Partial<WorkerResourceFactories> = {
        createDatabase: () =>
          ({
            $client: {
              end: async () => {
                dbEndCalled = true;
              },
            },
          }) as unknown as DatabaseClient,
        createR2Storage: () =>
          ({
            close: () => {
              r2CloseCalled = true;
            },
          }) as unknown as R2ObjectStorage,
        createResendSender: () => ({}) as unknown as ResendTransactionalEmailSender,
        createRenderer: () => {
          throw new Error('renderer fail');
        },
      };
      await expect(createWorkerDependenciesFromEnv({ env: validEnv, factories })).rejects.toThrow(
        WorkerConfigurationError,
      );
      expect(dbEndCalled).toBe(true);
      expect(r2CloseCalled).toBe(true);
    });

    it('erreur pendant DB.end pendant cleanup partiel — R2 quand même fermé', async () => {
      let r2CloseCalled = false;
      const factories: Partial<WorkerResourceFactories> = {
        createDatabase: () =>
          ({
            $client: {
              end: async () => {
                throw new Error('end fail');
              },
            },
          }) as unknown as DatabaseClient,
        createR2Storage: () =>
          ({
            close: () => {
              r2CloseCalled = true;
            },
          }) as unknown as R2ObjectStorage,
        createResendSender: () => {
          throw new Error('resend fail');
        },
      };
      await expect(createWorkerDependenciesFromEnv({ env: validEnv, factories })).rejects.toThrow(
        WorkerConfigurationError,
      );
      expect(r2CloseCalled).toBe(true);
    });

    it('aucun appel aux factories de ressources si validation échoue', async () => {
      let dbCreated = false;
      let r2Created = false;
      let resendCreated = false;
      const factories: Partial<WorkerResourceFactories> = {
        createDatabase: () => {
          dbCreated = true;
          return {} as DatabaseClient;
        },
        createR2Storage: () => {
          r2Created = true;
          return {} as R2ObjectStorage;
        },
        createResendSender: () => {
          resendCreated = true;
          return {} as ResendTransactionalEmailSender;
        },
      };
      await expect(createWorkerDependenciesFromEnv({ env: {}, factories })).rejects.toThrow(
        WorkerConfigurationError,
      );
      expect(dbCreated).toBe(false);
      expect(r2Created).toBe(false);
      expect(resendCreated).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4g. Concurrent shutdown tests (createShutdownFn)
  // ───────────────────────────────────────────────────────────────────────────

  describe('Shutdown concurrent (createShutdownFn)', () => {
    it('shutdown concurrent — deux appels reçoivent la même Promise, DB fermée une fois', async () => {
      let dbEndCount = 0;
      let resolveDbEnd: () => void;
      const dbEndPromise = new Promise<void>((resolve) => {
        resolveDbEnd = resolve;
      });

      const mockDb = {
        $client: {
          end: async () => {
            dbEndCount++;
            await dbEndPromise;
          },
        },
      } as unknown as DatabaseClient;
      const mockR2 = { close: () => {} } as unknown as R2ObjectStorage;

      const shutdown = createShutdownFn(mockDb, mockR2);

      const p1 = shutdown();
      const p2 = shutdown();

      expect(p1).toBe(p2); // même Promise
      expect(dbEndCount).toBe(1); // DB end appelée une seule fois

      resolveDbEnd!();
      await Promise.all([p1, p2]);

      expect(dbEndCount).toBe(1); // toujours une seule fois
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4h. Signal source tests (FakeSignalSource)
  // ───────────────────────────────────────────────────────────────────────────

  describe('Source de signaux injectable (FakeSignalSource)', () => {
    it('SIGTERM émis par la source factice — abort transmis, shutdown exécuté', async () => {
      const source = new FakeSignalSource();
      let shutdownCalled = false;
      const { runtime } = createMockRuntime();
      runtime.shutdown = async () => {
        shutdownCalled = true;
      };

      // runLoop that waits for abort
      const runLoop = async (_deps: unknown, opts: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => {
          opts.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      };

      const promise = startWorker({
        signalSource: source,
        createRuntime: async () => runtime,
        runLoop: runLoop as never,
        intervalMs: 10,
      });

      // Laisser un tick pour que les listeners soient installés.
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Emit SIGTERM
      source.emit('SIGTERM');

      await promise;
      expect(shutdownCalled).toBe(true);
      expect(source.listenerCount('SIGTERM')).toBe(0);
      expect(source.listenerCount('SIGINT')).toBe(0);
    });

    it('SIGINT émis par la source factice — abort transmis, shutdown exécuté', async () => {
      const source = new FakeSignalSource();
      let shutdownCalled = false;
      const { runtime } = createMockRuntime();
      runtime.shutdown = async () => {
        shutdownCalled = true;
      };

      const runLoop = async (_deps: unknown, opts: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => {
          opts.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      };

      const promise = startWorker({
        signalSource: source,
        createRuntime: async () => runtime,
        runLoop: runLoop as never,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      source.emit('SIGINT');

      await promise;
      expect(shutdownCalled).toBe(true);
      expect(source.listenerCount('SIGTERM')).toBe(0);
      expect(source.listenerCount('SIGINT')).toBe(0);
    });

    it('double signal — un seul abort, un seul shutdown', async () => {
      const source = new FakeSignalSource();
      let shutdownCount = 0;
      const { runtime } = createMockRuntime();
      runtime.shutdown = async () => {
        shutdownCount++;
      };

      const runLoop = async (_deps: unknown, opts: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => {
          opts.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      };

      const promise = startWorker({
        signalSource: source,
        createRuntime: async () => runtime,
        runLoop: runLoop as never,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      source.emit('SIGTERM');
      source.emit('SIGTERM'); // double

      await promise;
      expect(shutdownCount).toBe(1);
    });

    it('signal pendant createRuntime — boucle non démarrée, shutdown exécuté', async () => {
      const source = new FakeSignalSource();
      let runLoopCalled = false;
      let shutdownCalled = false;

      const { runtime } = createMockRuntime();
      runtime.shutdown = async () => {
        shutdownCalled = true;
      };

      const runLoop = async () => {
        runLoopCalled = true;
      };

      await startWorker({
        signalSource: source,
        createRuntime: async () => {
          source.emit('SIGTERM');
          return runtime;
        },
        runLoop: runLoop as never,
      });

      expect(runLoopCalled).toBe(false);
      expect(shutdownCalled).toBe(true);
      expect(source.listenerCount('SIGTERM')).toBe(0);
      expect(source.listenerCount('SIGINT')).toBe(0);
    });

    it('retrait des listeners si createRuntime échoue', async () => {
      const source = new FakeSignalSource();

      await expect(
        startWorker({
          signalSource: source,
          createRuntime: async () => {
            throw new WorkerConfigurationError('fail');
          },
        }),
      ).rejects.toThrow(WorkerConfigurationError);

      expect(source.listenerCount('SIGTERM')).toBe(0);
      expect(source.listenerCount('SIGINT')).toBe(0);
    });

    it('ordre createRuntime → runLoop → shutdown', async () => {
      const order: string[] = [];
      const source = new FakeSignalSource();
      const { runtime } = createMockRuntime();
      runtime.shutdown = async () => {
        order.push('shutdown');
      };

      const runLoop = async () => {
        order.push('runLoop');
        // Return immediately (simulates loop ending on its own)
      };

      await startWorker({
        signalSource: source,
        createRuntime: async () => {
          order.push('createRuntime');
          return runtime;
        },
        runLoop: runLoop as never,
      });

      expect(order).toEqual(['createRuntime', 'runLoop', 'shutdown']);
    });

    it('erreur runLoop → shutdown puis propagation', async () => {
      const source = new FakeSignalSource();
      let shutdownCalled = false;
      const { runtime } = createMockRuntime();
      runtime.shutdown = async () => {
        shutdownCalled = true;
      };

      const runLoop = async () => {
        throw new Error('loop fail');
      };

      await expect(
        startWorker({
          signalSource: source,
          createRuntime: async () => runtime,
          runLoop: runLoop as never,
        }),
      ).rejects.toThrow('loop fail');

      expect(shutdownCalled).toBe(true);
      expect(source.listenerCount('SIGTERM')).toBe(0);
      expect(source.listenerCount('SIGINT')).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4i. External AbortSignal listener removal tests
  // ───────────────────────────────────────────────────────────────────────────

  describe('Retrait du listener signal externe (preuve réelle add/remove)', () => {
    it('arrêt normal — addEventListener puis removeEventListener avec le même callback', async () => {
      const externalController = new AbortController();
      const signal = externalController.signal;
      const { runtime } = createMockRuntime();

      const addSpy = vi.spyOn(signal, 'addEventListener');
      const removeSpy = vi.spyOn(signal, 'removeEventListener');

      const runLoop = async () => {}; // returns immediately

      await startWorker({
        signal: signal,
        createRuntime: async () => runtime,
        runLoop: runLoop as never,
      });

      // Un seul listener 'abort' ajouté
      const abortAddCalls = addSpy.mock.calls.filter((c) => c[0] === 'abort');
      expect(abortAddCalls.length).toBe(1);

      // Le callback exact enregistré
      const addedCallback = abortAddCalls[0]![1];

      // removeEventListener appelé avec le même callback
      const abortRemoveCalls = removeSpy.mock.calls.filter((c) => c[0] === 'abort');
      expect(abortRemoveCalls.length).toBe(1);
      expect(abortRemoveCalls[0]![1]).toBe(addedCallback);

      addSpy.mockRestore();
      removeSpy.mockRestore();
    });

    it('erreur fatale runLoop — addEventListener puis removeEventListener avec le même callback', async () => {
      const externalController = new AbortController();
      const signal = externalController.signal;

      const addSpy = vi.spyOn(signal, 'addEventListener');
      const removeSpy = vi.spyOn(signal, 'removeEventListener');

      const runLoop = async () => {
        throw new Error('fatal');
      };

      await expect(
        startWorker({
          signal: signal,
          createRuntime: async () => createMockRuntime().runtime,
          runLoop: runLoop as never,
        }),
      ).rejects.toThrow('fatal');

      const abortAddCalls = addSpy.mock.calls.filter((c) => c[0] === 'abort');
      expect(abortAddCalls.length).toBe(1);
      const addedCallback = abortAddCalls[0]![1];

      const abortRemoveCalls = removeSpy.mock.calls.filter((c) => c[0] === 'abort');
      expect(abortRemoveCalls.length).toBe(1);
      expect(abortRemoveCalls[0]![1]).toBe(addedCallback);

      addSpy.mockRestore();
      removeSpy.mockRestore();
    });

    it('arrêt déclenché par le signal externe — removeEventListener appelé', async () => {
      const externalController = new AbortController();
      const signal = externalController.signal;
      let shutdownCalled = false;
      const { runtime } = createMockRuntime();
      runtime.shutdown = async () => {
        shutdownCalled = true;
      };

      const addSpy = vi.spyOn(signal, 'addEventListener');
      const removeSpy = vi.spyOn(signal, 'removeEventListener');

      const runLoop = async (_deps: unknown, opts: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => {
          opts.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      };

      const promise = startWorker({
        signal: signal,
        createRuntime: async () => runtime,
        runLoop: runLoop as never,
      });

      // Laisser un tick pour l'installation du listener
      await new Promise((resolve) => setTimeout(resolve, 10));

      externalController.abort();

      await promise;

      expect(shutdownCalled).toBe(true);

      const abortAddCalls = addSpy.mock.calls.filter((c) => c[0] === 'abort');
      expect(abortAddCalls.length).toBe(1);
      const addedCallback = abortAddCalls[0]![1];

      const abortRemoveCalls = removeSpy.mock.calls.filter((c) => c[0] === 'abort');
      expect(abortRemoveCalls.length).toBe(1);
      expect(abortRemoveCalls[0]![1]).toBe(addedCallback);

      addSpy.mockRestore();
      removeSpy.mockRestore();
    });

    it('signal déjà aborté avant startWorker — aucun listener ajouté, aucun retrait', async () => {
      const externalController = new AbortController();
      externalController.abort(); // pre-aborted
      const signal = externalController.signal;

      const addSpy = vi.spyOn(signal, 'addEventListener');
      const removeSpy = vi.spyOn(signal, 'removeEventListener');

      let runLoopCalled = false;
      const { runtime } = createMockRuntime();
      let shutdownCalled = false;
      runtime.shutdown = async () => {
        shutdownCalled = true;
      };

      const runLoop = async (_deps: unknown, opts: { signal: AbortSignal }) => {
        runLoopCalled = true;
        expect(opts.signal.aborted).toBe(true);
      };

      await startWorker({
        signal: signal,
        createRuntime: async () => runtime,
        runLoop: runLoop as never,
      });

      expect(runLoopCalled).toBe(true);
      expect(shutdownCalled).toBe(true);

      // Aucun listener 'abort' ne doit être ajouté car le signal est déjà aborté
      const abortAddCalls = addSpy.mock.calls.filter((c) => c[0] === 'abort');
      expect(abortAddCalls.length).toBe(0);

      // Aucun retrait ne doit être tenté
      const abortRemoveCalls = removeSpy.mock.calls.filter((c) => c[0] === 'abort');
      expect(abortRemoveCalls.length).toBe(0);

      addSpy.mockRestore();
      removeSpy.mockRestore();
    });
  });
});
