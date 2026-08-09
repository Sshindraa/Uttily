/**
 * @uttily/worker — Harness de smoke test du bundle compilé (G5H-C2C-B4 round 3).
 *
 * Ce harness est un script de développement (jamais importé par la production).
 * Il importe dynamiquement le bundle esbuild `apps/worker/dist/index.js` (le
 * code réellement déployé), vérifie les exports requis, puis orchestre un
 * cycle start/SIGTERM/shutdown avec des fakes — AUCUN appel réel à PostgreSQL,
 * R2 ou Resend. Aucun secret n'est lu ni affiché.
 *
 * Tous les chemins sont résolus depuis `import.meta.url` (jamais depuis cwd).
 * Un timeout ferme (référencé, jamais détaché) garantit la terminaison même en cas
 * de régression de boucle infinie. Sur succès, le processus termine
 * naturellement (pas de process.exit(0)) pour prouver qu'aucun handle ne
 * reste actif.
 *
 * Round 3 : capture des effets console différés via setImmediate pendant et
 * après l'import ; validation stricte de `--timeout-ms` (regex `^[0-9]+$` +
 * Number.isSafeInteger + borne [50, 10000], fail-closed exit 64 sans
 * interpolation de la valeur reçue).
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultBundlePath = resolve(scriptDir, '..', 'dist', 'index.js');

// ─────────────────────────────────────────────────────────────────────────────
// CLI parsing — --bundle=<path> et --timeout-ms=<N> (DEV-HARNESS ONLY).
// ─────────────────────────────────────────────────────────────────────────────

function parseBundleArg(argv) {
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--bundle=')) {
      return arg.slice('--bundle='.length);
    }
  }
  return null;
}

function parseTimeoutMsArg(argv) {
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--timeout-ms=')) {
      const raw = arg.slice('--timeout-ms='.length);
      // Validation stricte : décimal uniquement, pas de parseInt (qui accepte
      // "100junk" et "100.5"). On utilise Number(raw) + regex ^[0-9]+$.
      if (!/^[0-9]+$/.test(raw)) {
        console.error('Worker smoke: timeout invalide');
        process.exit(64);
      }
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < 50 || parsed > 10000) {
        console.error('Worker smoke: timeout invalide');
        process.exit(64);
      }
      return parsed;
    }
  }
  return 5000;
}

// Validation du timeout AVANT toute création de timer ou import — un timeout
// invalide ne doit jamais démarrer le timer de fallback 5000 ms.
const SMOKE_TIMEOUT_MS = parseTimeoutMsArg(process.argv);
const bundleArg = parseBundleArg(process.argv);
const bundlePath = bundleArg ?? defaultBundlePath;

// ─────────────────────────────────────────────────────────────────────────────
// Timeout ferme (référencé) — garantit la terminaison même si startWorker hang.
// Le timer reste référencé pour tout le durée du smoke : il maintient l'event
// loop en vie et se déclenche même si startWorker ne résout jamais.
// Il est nettoyé (clearTimeout) sur chaque chemin de succès ou d'échec géré.
// ─────────────────────────────────────────────────────────────────────────────

const timeoutTimer = setTimeout(() => {
  console.error('Worker smoke: timeout dépassé');
  process.exit(70);
}, SMOKE_TIMEOUT_MS);

// ─────────────────────────────────────────────────────────────────────────────
// FakeSignalSource — source de signaux factice (mirror FakeSignalSource).
// ─────────────────────────────────────────────────────────────────────────────

class FakeSignalSource {
  constructor() {
    this.listeners = new Map();
  }

  on(signal, listener) {
    const arr = this.listeners.get(signal) ?? [];
    arr.push(listener);
    this.listeners.set(signal, arr);
  }

  removeListener(signal, listener) {
    const arr = this.listeners.get(signal) ?? [];
    const idx = arr.indexOf(listener);
    if (idx >= 0) arr.splice(idx, 1);
    this.listeners.set(signal, arr);
  }

  emit(signal) {
    const arr = this.listeners.get(signal) ?? [];
    for (const l of arr) l();
  }

  listenerCount(signal) {
    return (this.listeners.get(signal) ?? []).length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FakeRuntime — runtime minimal avec shutdown idempotent.
// ─────────────────────────────────────────────────────────────────────────────

function createFakeRuntime() {
  let shutdownCount = 0;
  let shutdownPromise = null;
  const dependencies = {};

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownCount += 1;
    shutdownPromise = Promise.resolve();
    return shutdownPromise;
  };

  return {
    runtime: { dependencies, shutdown },
    getShutdownCount: () => shutdownCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertions.
// ─────────────────────────────────────────────────────────────────────────────

function assert(name, condition) {
  if (!condition) {
    console.error(`Worker smoke: assertion échouée — ${name}`);
    clearTimeout(timeoutTimer);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scrub des variables d'environnement des providers AVANT l'import.
// On supprime sans lire, copier, sauvegarder ni afficher les valeurs.
// Cela garantit qu'une régression déclenchant l'entrée main à l'import échoue
// avant toute création de ressource distante.
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDER_ENV_VARS = [
  'DATABASE_URL',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'RESEND_BOOKING_CONFIRMED_TEMPLATE_ID',
];

for (const key of PROVIDER_ENV_VARS) {
  delete process.env[key];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main.
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Vérifier l'existence du bundle.
  if (!existsSync(bundlePath)) {
    console.error('Worker smoke: bundle introuvable (dist/index.js absent).');
    clearTimeout(timeoutTimer);
    process.exit(2);
  }

  // 2. Enregistrer l'état avant import pour prouver l'absence d'effets de bord.
  const exitCodeBefore = process.exitCode;
  const sigtermBefore = process.listenerCount('SIGTERM');
  const sigintBefore = process.listenerCount('SIGINT');

  // 3. Capturer temporairement les appels console pendant l'import ET le tour
  //    setImmediate qui suit — compter SANS stocker ni forwarder aucun contenu.
  //    Les consoles restent remplacées pendant l'import ET pendant au moins un
  //    tour setImmediate après l'import, pour détecter les console.log différés
  //    (setImmediate schedulé au top-level du bundle). La restauration se fait
  //    dans un unique bloc finally qui s'exécute après ce tour setImmediate.
  let consoleCallCount = 0;
  const origInfo = console.info;
  const origLog = console.log;
  const origError = console.error;
  console.info = () => {
    consoleCallCount++;
  };
  console.log = () => {
    consoleCallCount++;
  };
  console.error = () => {
    consoleCallCount++;
  };

  // 4. Importer le bundle dynamiquement, puis laisser un tour d'event loop pour
  //    que toute exécution différée (setImmediate schedulé au top-level du
  //    bundle pendant l'import) apparaisse et soit comptée. Les consoles sont
  //    restaurées dans le finally UNIQUE après ce tour setImmediate. En cas
  //    d'échec d'import, on restore d'abord les consoles (dans le finally), puis
  //    on imprime le message générique avec les vraies consoles, puis on exit.
  let worker;
  let importFailed = false;
  try {
    worker = await import(bundlePath);
    // Laisser un tour d'event loop pour que toute exécution différée
    // apparaisse — les consoles sont ENCORE remplacées pendant ce tour.
    await new Promise((r) => setImmediate(r));
  } catch {
    importFailed = true;
    worker = undefined;
  } finally {
    // Restauration unique — les consoles restent remplacées pendant l'import
    // ET pendant le tour setImmediate qui suit.
    console.info = origInfo;
    console.log = origLog;
    console.error = origError;
  }

  // Si l'import a échoué, les consoles sont maintenant restaurées : on imprime
  // le message générique avec les vraies consoles, puis on exit.
  if (importFailed) {
    console.error('Worker smoke: échec de l import du bundle.');
    clearTimeout(timeoutTimer);
    process.exit(3);
  }

  // 5. Prouver l'absence d'effets de bord à l'import (couvre import + tour setImmediate).
  assert('process.exitCode inchangé après import', process.exitCode === exitCodeBefore);
  assert(
    'listenerCount SIGTERM inchangé après import',
    process.listenerCount('SIGTERM') === sigtermBefore,
  );
  assert(
    'listenerCount SIGINT inchangé après import',
    process.listenerCount('SIGINT') === sigintBefore,
  );
  assert('aucune sortie console pendant l import', consoleCallCount === 0);

  // 7. Vérifier les exports requis (noms génériques uniquement).
  const requiredExports = [
    'startWorker',
    'createWorkerDependenciesFromEnv',
    'PdfLibDocumentRenderer',
    'R2ObjectStorage',
    'ResendTransactionalEmailSender',
    'WorkerConfigurationError',
  ];
  const missing = requiredExports.filter((name) => typeof worker[name] === 'undefined');
  if (missing.length > 0) {
    console.error(`Worker smoke: exports manquants — ${missing.join(', ')}`);
    clearTimeout(timeoutTimer);
    process.exit(4);
  }

  // 8. Vérifier que startWorker est une fonction (pas d'auto-start à l'import).
  assert('startWorker est une fonction', typeof worker.startWorker === 'function');

  // 9. Construire les fakes.
  const fakeSignalSource = new FakeSignalSource();
  const { runtime: fakeRuntime, getShutdownCount } = createFakeRuntime();

  let loopStarted = false;
  let signalAbortedAtStart = false;
  let signalAbortedAtEnd = false;

  const fakeRunLoop = async (_deps, options) => {
    loopStarted = true;
    signalAbortedAtStart = options.signal.aborted;
    // Émettre un faux SIGTERM dès que la boucle a démarré (prochain microtask),
    // avant d'attendre l'abort — garantit la coordination.
    queueMicrotask(() => fakeSignalSource.emit('SIGTERM'));
    await new Promise((r) => {
      options.signal.addEventListener('abort', () => r(), { once: true });
    });
    signalAbortedAtEnd = options.signal.aborted;
  };

  // 10. Démarrer le worker avec les fakes.
  await worker.startWorker({
    intervalMs: 10,
    batchLimit: 1,
    createRuntime: async () => fakeRuntime,
    signalSource: fakeSignalSource,
    runLoop: fakeRunLoop,
  });

  // 11. Assertions post-completion.
  assert('loopStarted === true', loopStarted === true);
  assert('signalAbortedAtStart === false', signalAbortedAtStart === false);
  assert('signalAbortedAtEnd === true', signalAbortedAtEnd === true);
  assert('shutdownCount === 1', getShutdownCount() === 1);
  assert('listenerCount SIGTERM === 0', fakeSignalSource.listenerCount('SIGTERM') === 0);
  assert('listenerCount SIGINT === 0', fakeSignalSource.listenerCount('SIGINT') === 0);

  // 12. Succès — terminaison naturelle (pas de process.exit(0)).
  //     Le clearTimeout permet à l'event loop de se vider ; le processus
  //     termine de lui-même, prouvant qu'aucun handle ne reste actif.
  clearTimeout(timeoutTimer);
  console.log('Worker smoke: OK (bundle loaded, start/shutdown verified)');
}

main().catch(() => {
  console.error('Worker smoke: erreur inattendue.');
  clearTimeout(timeoutTimer);
  process.exit(1);
});
