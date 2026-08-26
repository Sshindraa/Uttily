import type { DatabaseClient } from '@uttily/database';
import { fileURLToPath } from 'node:url';

const LOCAL_DATABASE_URL = 'postgresql://uttily:uttily@127.0.0.1:5432/uttily';
const LOCAL_DATABASE_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DEFAULT_INTERVAL_MS = 5_000;
export const MAX_LOCAL_WORKER_INTERVAL_MS = 2_147_483_647;
const BATCH_LIMIT = 10;

class LocalWorkerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalWorkerConfigurationError';
  }
}

export function isLocalDatabaseUrl(value: unknown) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
      LOCAL_DATABASE_HOSTNAMES.has(parsed.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

export function resolveDatabaseUrl(environment: NodeJS.ProcessEnv) {
  const databaseUrl = environment.DATABASE_URL ?? LOCAL_DATABASE_URL;
  if (!isLocalDatabaseUrl(databaseUrl)) {
    throw new LocalWorkerConfigurationError(
      'DATABASE_URL doit pointer vers PostgreSQL local ; le worker fake refuse toute base distante.',
    );
  }
  return databaseUrl;
}

export function resolveLocalWorkerIntervalMs(environment: NodeJS.ProcessEnv) {
  const rawInterval = environment.WORKER_INTERVAL_MS;
  if (rawInterval === undefined) return DEFAULT_INTERVAL_MS;

  const intervalMs = Number(rawInterval);
  if (
    !Number.isInteger(intervalMs) ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0 ||
    intervalMs > MAX_LOCAL_WORKER_INTERVAL_MS
  ) {
    throw new LocalWorkerConfigurationError(
      `WORKER_INTERVAL_MS doit être un entier fini strictement positif inférieur ou égal à ${MAX_LOCAL_WORKER_INTERVAL_MS}.`,
    );
  }
  return intervalMs;
}

/** Lance le worker local avec la base locale et des providers exclusivement fake. */
export async function runLocalWorker(environment = process.env) {
  const databaseUrl = resolveDatabaseUrl(environment);
  const intervalMs = resolveLocalWorkerIntervalMs(environment);
  const [
    { createDatabase },
    { FakeDeterministicDocumentRenderer, FakeTransactionalEmailSender, InMemoryObjectStorage },
    { createWorkerDependenciesForTesting, runWorkerLoop },
  ] = await Promise.all([import('@uttily/database'), import('@uttily/core'), import('./index.js')]);
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  let db: DatabaseClient | undefined;

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    db = createDatabase(databaseUrl);
    const dependencies = createWorkerDependenciesForTesting({
      db,
      renderer: new FakeDeterministicDocumentRenderer(),
      storage: new InMemoryObjectStorage(),
      sender: new FakeTransactionalEmailSender(),
    });

    console.log('Worker local: providers fake activés ; aucun appel R2/Resend.');
    await runWorkerLoop(dependencies, {
      intervalMs,
      batchLimit: BATCH_LIMIT,
      signal: controller.signal,
    });
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (db) await db.$client.end();
  }
}

function isMainModule() {
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runLocalWorker().catch((error) => {
    if (error instanceof LocalWorkerConfigurationError) {
      console.error(`Worker local: configuration refusée — ${error.message}`);
    } else {
      console.error('Worker local: échec inattendu ; arrêt sans appel fournisseur.');
    }
    process.exitCode = 1;
  });
}
