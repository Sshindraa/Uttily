/**
 * DEV-ONLY fixture for smoke harness hang test. Never included in dist/.
 * Never imported by production.
 *
 * Ce module simule un bundle cassé dont `startWorker` ne résout jamais.
 * Il exporte tous les noms requis par le harness mais `startWorker` retourne
 * une Promise qui ne settle jamais. Aucun effet de bord au chargement, aucun
 * appel réseau, aucun accès à des secrets.
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
