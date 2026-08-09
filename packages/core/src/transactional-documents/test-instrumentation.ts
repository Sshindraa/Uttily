/**
 * @uttily/core — Instrumentation de test pour vérifier qu'aucun appel externe
 * (renderer/storage) n'est effectué pendant une transaction active (G5D, ADR-013 §11).
 *
 * NE JAMAIS utiliser en production. Utilitaires de test uniquement.
 *
 * Principe : un TransactionMonitor suit si une transaction est active. Les
 * wrappers instrumentés du renderer et du storage vérifient que le flag est
 * false lors de chaque appel. Si un appel externe est fait pendant une
 * transaction, une violation est enregistrée (ou une erreur est levée).
 *
 * wrapDatabase monkey-patche db.transaction pour appeler monitor.begin() avant
 * le callback de transaction et monitor.end() dans un bloc finally.
 */

import type { DatabaseClient } from '@uttily/database';
import type { DocumentRenderer, ObjectStorage } from './ports';
import type { RenderedDocument, ObjectStoragePutResult, StoredObjectMetadata } from './types';
import type { DocumentRenderSnapshotV1 } from './snapshot-types';

/**
 * Moniteur de transaction — suit si une transaction PostgreSQL est active.
 *
 * violations enregistre chaque appel externe (renderer/storage) effectué
 * pendant une transaction active. Le test doit vérifier que violations.length
 * === 0 après l'exécution du pipeline.
 */
export class TransactionMonitor {
  private active = false;
  violations: Array<{ method: string; timestamp: number }> = [];

  /** Indique si une transaction est actuellement active. */
  isActive(): boolean {
    return this.active;
  }

  /** Marque le début d'une transaction. */
  begin(): void {
    this.active = true;
  }

  /** Marque la fin d'une transaction. */
  end(): void {
    this.active = false;
  }

  /** Enregistre une violation : appel externe pendant une transaction active. */
  recordViolation(method: string): void {
    this.violations.push({ method, timestamp: Date.now() });
  }
}

/**
 * Wrap un DatabaseClient pour intercepter db.transaction.
 *
 * Avant chaque transaction, monitor.begin() est appelé. Après (dans finally),
 * monitor.end() est appelé. Cela permet aux wrappers instrumentés du renderer
 * et du storage de détecter les appels externes pendant une transaction.
 */
export function wrapDatabase(db: DatabaseClient): {
  db: DatabaseClient;
  monitor: TransactionMonitor;
} {
  const monitor = new TransactionMonitor();
  const originalTransaction = db.transaction.bind(db);
  const wrappedDb = Object.create(db) as DatabaseClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrappedDb.transaction = async function <T>(fn: (tx: any) => Promise<T>): Promise<T> {
    monitor.begin();
    try {
      return await originalTransaction(fn);
    } finally {
      monitor.end();
    }
  };
  return { db: wrappedDb, monitor };
}

export interface InstrumentedRendererCall {
  readonly method: string;
  readonly time: number;
  readonly templateKey: string;
}

/**
 * Crée un renderer instrumenté qui enregistre tous les appels et vérifie
 * qu'aucun appel n'est fait pendant une transaction active.
 *
 * Si monitor.isActive() est true lors d'un appel, une violation est enregistrée
 * dans monitor.violations.
 */
export function createInstrumentedRenderer(
  inner: DocumentRenderer,
  monitor: TransactionMonitor,
): {
  renderer: DocumentRenderer;
  calls: InstrumentedRendererCall[];
} {
  const calls: InstrumentedRendererCall[] = [];

  const renderer: DocumentRenderer = {
    async render(
      templateKey: string,
      snapshot: DocumentRenderSnapshotV1,
    ): Promise<RenderedDocument> {
      if (monitor.isActive()) {
        monitor.recordViolation('renderer.render');
      }
      calls.push({ method: 'render', time: Date.now(), templateKey });
      return inner.render(templateKey, snapshot);
    },
  };

  return { renderer, calls };
}

export interface InstrumentedStorageCall {
  readonly method: string;
  readonly time: number;
  readonly key: string;
}

/**
 * Crée un storage instrumenté qui enregistre tous les appels et vérifie
 * qu'aucun appel n'est fait pendant une transaction active.
 *
 * Si monitor.isActive() est true lors d'un appel, une violation est enregistrée
 * dans monitor.violations.
 */
export function createInstrumentedStorage(
  inner: ObjectStorage,
  monitor: TransactionMonitor,
): {
  storage: ObjectStorage;
  calls: InstrumentedStorageCall[];
} {
  const calls: InstrumentedStorageCall[] = [];

  const storage: ObjectStorage = {
    async putIfAbsent(input: {
      readonly key: string;
      readonly content: Uint8Array;
      readonly contentType: string;
      readonly checksumSha256: string;
      readonly sizeBytes: number;
    }): Promise<ObjectStoragePutResult> {
      if (monitor.isActive()) {
        monitor.recordViolation('storage.putIfAbsent');
      }
      calls.push({ method: 'putIfAbsent', time: Date.now(), key: input.key });
      return inner.putIfAbsent(input);
    },

    async head(key: string): Promise<StoredObjectMetadata | null> {
      if (monitor.isActive()) {
        monitor.recordViolation('storage.head');
      }
      calls.push({ method: 'head', time: Date.now(), key });
      return inner.head(key);
    },

    async get(key: string): Promise<Uint8Array> {
      if (monitor.isActive()) {
        monitor.recordViolation('storage.get');
      }
      calls.push({ method: 'get', time: Date.now(), key });
      return inner.get(key);
    },
  };

  return { storage, calls };
}
