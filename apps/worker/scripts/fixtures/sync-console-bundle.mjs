/**
 * DEV-ONLY fixture for smoke harness synchronous console capture test.
 * Never included in dist/. Never imported by production.
 *
 * Ce module simule un bundle qui appelle `console.log` synchronously au
 * top-level pendant l'import. Le harness doit détecter cette fuite console
 * synchrone et échouer avec exit 1 (assertion `consoleCallCount === 0`).
 * `startWorker` retourne une Promise qui ne settle jamais (comme
 * hanging-bundle.mjs) mais le point réel est la détection du console.log
 * synchrone. Aucun appel réseau, aucun accès à des secrets.
 */

export class WorkerConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkerConfigurationError';
  }
}

export class PdfLibDocumentRenderer {}

export class R2ObjectStorage {}

export class ResendTransactionalEmailSender {}

export async function createWorkerDependenciesFromEnv() {
  // No-op : aucune dépendance réelle.
}

export function startWorker() {
  // Jamais résout — simule un hang de la boucle worker.
  return new Promise(() => {});
}

// Appel synchrone au top-level pendant l'import — doit être détecté par le
// compteur console du harness.
console.log('sync leak');
