/**
 * DEV-ONLY fixture for smoke harness deferred console capture test.
 * Never included in dist/. Never imported by production.
 *
 * Ce module simule un bundle qui planifie un `console.log` différée via
 * `setImmediate` au top-level pendant l'import. Le harness doit détecter cette
 * fuite console différée pendant son tour `setImmediate` après l'import et
 * échouer avec exit 1 (assertion `consoleCallCount === 0`), AVANT que le
 * timeout ne se déclenche. `startWorker` retourne une Promise qui ne settle
 * jamais (comme hanging-bundle.mjs) mais le point réel est la détection du
 * console.log différée. Aucun appel réseau, aucun accès à des secrets.
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

// Planifier un console.log différée via setImmediate au top-level — doit
// s'exécuter pendant le tour setImmediate du harness après l'import.
setImmediate(() => {
  console.log('deferred leak');
});
