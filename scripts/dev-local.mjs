import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCAL_DATABASE_URL = 'postgresql://uttily:uttily@127.0.0.1:5432/uttily';

// Valeur de signature dev/test uniquement : non secrète et interdite en staging/production.
export const LOCAL_DEV_PUBLIC_SEARCH_CURSOR_SECRET = 'uttily-local-dev-public-search-cursor-v1';
export const LOCAL_PUBLIC_APP_URL = 'http://localhost:3000';

const LOCAL_DATABASE_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DATABASE_VARIABLES = ['DATABASE_URL', 'DATABASE_DIRECT_URL'];
const STRIPE_TEST_KEY_PREFIXES = {
  STRIPE_SECRET_KEY: 'sk_test_',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_',
};
const CLERK_TEST_KEY_PREFIXES = {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_',
  CLERK_SECRET_KEY: 'sk_test_',
};
const CLERK_TEST_KEY_SUFFIX_PATTERN = /^[A-Za-z0-9_-]{16,}$/;
const LOCAL_WEBHOOK_SECRETS = [
  'CLERK_WEBHOOK_SECRET',
  'STRIPE_PLATFORM_WEBHOOK_SECRET',
  'STRIPE_CONNECT_WEBHOOK_SECRET',
];
const LOCAL_CRON_SECRET = 'dev-cron-secret-local';
const LOCAL_PROVIDER_CREDENTIALS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'RESEND_BOOKING_CONFIRMED_TEMPLATE_ID',
];
const DOCKER_ENVIRONMENT_VARIABLES = [
  'PATH',
  'HOME',
  'USER',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'COMPOSE_PROJECT_NAME',
  'COMPOSE_PROFILES',
];
const POSIX_PROCESS_GROUPS = process.platform !== 'win32';
const MANAGED_PROCESS_GROUPS = new WeakSet();
const POSTGRES_HOST = '127.0.0.1';
const POSTGRES_PORT = 5432;
const POSTGRES_WAIT_TIMEOUT_MS = 30_000;
const POSTGRES_MAX_ATTEMPTS = 60;
const POSTGRES_RETRY_INTERVAL_MS = 500;
const POSTGRES_CONNECT_TIMEOUT_MS = 1_000;
const POSTGRES_HEALTHCHECK_TIMEOUT_MS = 1_000;
const COMPOSE_DETECTION_TIMEOUT_MS = 5_000;
const DOCKER_CONTEXT_INSPECTION_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_GRACE_MS = 250;
const PROCESS_GROUP_DISAPPEARANCE_POLL_MS = 20;
const PROCESS_GROUP_DISAPPEARANCE_TIMEOUT_MS = 1_000;
const COMPOSE_UP_TIMEOUT_MS = 120_000;
const MIGRATIONS_TIMEOUT_MS = 120_000;
const CHILD_SHUTDOWN_TIMEOUT_MS = 10_000;
const REPOSITORY_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const COMPOSE_FILE = resolve(REPOSITORY_ROOT, 'docker-compose.yml');
const LOCAL_DOCKER_CONTEXTS = new Set(['default', 'colima', 'desktop-linux', 'docker-desktop']);

/**
 * Vérifie sans effet de bord qu'une URL PostgreSQL pointe vers la machine locale.
 * Les valeurs non parseables et les protocoles non PostgreSQL sont refusés.
 */
export function isLocalDatabaseUrl(value) {
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

function isValidClerkTestKey(value, prefix) {
  return (
    typeof value === 'string' &&
    value.startsWith(prefix) &&
    CLERK_TEST_KEY_SUFFIX_PATTERN.test(value.slice(prefix.length))
  );
}

/**
 * Construit l'environnement hermétique du workflow local.
 * Les URLs existantes sont contrôlées avant d'être remplacées par les URLs fixes.
 */
export function createLocalEnvironment(baseEnvironment = process.env) {
  for (const variable of DATABASE_VARIABLES) {
    const value = baseEnvironment[variable];
    if (value !== undefined && !isLocalDatabaseUrl(value)) {
      throw new Error(`${variable} doit pointer vers PostgreSQL local.`);
    }
  }

  for (const [variable, prefix] of Object.entries(STRIPE_TEST_KEY_PREFIXES)) {
    const value = baseEnvironment[variable];
    if (
      value !== undefined &&
      value !== '' &&
      (typeof value !== 'string' || !value.startsWith(prefix))
    ) {
      throw new Error(`configuration Stripe TEST invalide pour ${variable}.`);
    }
  }

  for (const [variable, prefix] of Object.entries(CLERK_TEST_KEY_PREFIXES)) {
    const value = baseEnvironment[variable];
    if (!isValidClerkTestKey(value, prefix)) {
      throw new Error(`configuration Clerk TEST invalide pour ${variable}.`);
    }
  }

  const sanitizedBaseEnvironment = { ...baseEnvironment };
  // Ne pas laisser fuiter l'ancien taux même lorsqu'il est présent dans le
  // shell appelant : le registre serveur est désormais l'unique autorité.
  delete sanitizedBaseEnvironment.PLATFORM_COMMISSION_RATE_BPS;

  const childEnvironment = {
    ...sanitizedBaseEnvironment,
    NODE_ENV: 'development',
    UTTILY_LOCAL_DEV: '1',
    DATABASE_URL: LOCAL_DATABASE_URL,
    DATABASE_DIRECT_URL: LOCAL_DATABASE_URL,
    STRIPE_ENVIRONMENT: 'TEST',
    PAYMENTS_LIVE_ENABLED: 'false',
    STRIPE_SECRET_KEY: baseEnvironment.STRIPE_SECRET_KEY ?? '',
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: baseEnvironment.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '',
    PUBLIC_APP_URL: LOCAL_PUBLIC_APP_URL,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: baseEnvironment.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    CLERK_SECRET_KEY: baseEnvironment.CLERK_SECRET_KEY,
    PUBLIC_SEARCH_CURSOR_SECRET: LOCAL_DEV_PUBLIC_SEARCH_CURSOR_SECRET,
    ALLOWED_ORIGINS: '',
    CRON_SECRET: LOCAL_CRON_SECRET,
  };

  // Les clés restent présentes mais vides : Next.js ne peut pas les réinjecter depuis `.env.local`.
  for (const variable of LOCAL_PROVIDER_CREDENTIALS) {
    childEnvironment[variable] = '';
  }
  for (const variable of LOCAL_WEBHOOK_SECRETS) {
    childEnvironment[variable] = '';
  }

  return childEnvironment;
}

/**
 * Construit l'environnement minimal transmis aux commandes Docker/Compose locales.
 * Les overrides permettent de conserver les choix d'endpoint ou de contexte épinglés.
 */
export function createDockerEnvironment(baseEnvironment = process.env, overrides = {}) {
  const sourceEnvironment = { ...(baseEnvironment ?? {}), ...(overrides ?? {}) };
  const dockerEnvironment = {};

  for (const variable of DOCKER_ENVIRONMENT_VARIABLES) {
    if (sourceEnvironment[variable] !== undefined) {
      dockerEnvironment[variable] = sourceEnvironment[variable];
    }
  }

  return dockerEnvironment;
}

/**
 * Construit l'environnement réservé à l'inspection du contexte Docker.
 * Un contexte explicitement défini est prioritaire sur DOCKER_HOST.
 */
export function createDockerInspectionEnvironment(baseEnvironment = process.env) {
  const inspectionEnvironment = createDockerEnvironment(baseEnvironment);
  if (inspectionEnvironment.DOCKER_CONTEXT !== undefined) {
    delete inspectionEnvironment.DOCKER_HOST;
  }
  return inspectionEnvironment;
}

/** Refuse les schémas Docker qui désignent explicitement un moteur distant. */
export function isRemoteDockerHost(value) {
  return typeof value === 'string' && /^(?:tcp|ssh|https?):/i.test(value.trim());
}

/** Autorise uniquement les endpoints Docker locaux connus. */
export function isLocalDockerEndpoint(value) {
  return typeof value === 'string' && /^(?:unix|npipe):/i.test(value.trim());
}

/** Autorise uniquement les contextes Docker locaux connus de ce workflow. */
export function isAllowedDockerContext(value) {
  return value === undefined || LOCAL_DOCKER_CONTEXTS.has(value);
}

/**
 * Valide l'inspection JSON du contexte Docker sans exposer son nom ni son endpoint.
 * L'inspection Docker est un tableau contenant exactement le contexte demandé.
 */
function validateDockerContextDetails(contextName, inspection) {
  if (typeof contextName !== 'string' || !LOCAL_DOCKER_CONTEXTS.has(contextName)) {
    return { ok: false, error: 'un contexte Docker non local est configuré.' };
  }

  let parsedInspection = inspection;
  if (typeof inspection === 'string') {
    try {
      parsedInspection = JSON.parse(inspection);
    } catch {
      return { ok: false, error: 'impossible d’inspecter le contexte Docker local.' };
    }
  }

  if (!Array.isArray(parsedInspection) || parsedInspection.length !== 1) {
    return { ok: false, error: 'impossible d’inspecter le contexte Docker local.' };
  }

  const inspectedContext = parsedInspection[0];
  if (inspectedContext?.Name !== contextName) {
    return { ok: false, error: 'impossible d’inspecter le contexte Docker local.' };
  }

  const endpoint = inspectedContext?.Endpoints?.docker?.Host;
  if (!isLocalDockerEndpoint(endpoint)) {
    return { ok: false, error: 'un endpoint Docker distant ou non local a été sélectionné.' };
  }

  return { ok: true, contextName, endpoint };
}

export function validateDockerContext(contextName, inspection) {
  const validation = validateDockerContextDetails(contextName, inspection);
  return validation.ok ? null : validation.error;
}

/** Retourne un message générique sans révéler les valeurs de configuration. */
export function getDockerEnvironmentError(environment = {}) {
  if (environment.DOCKER_HOST !== undefined && !isLocalDockerEndpoint(environment.DOCKER_HOST)) {
    return isRemoteDockerHost(environment.DOCKER_HOST)
      ? 'un moteur Docker distant est configuré.'
      : 'un endpoint Docker non local est configuré.';
  }
  if (!isAllowedDockerContext(environment.DOCKER_CONTEXT)) {
    return 'un contexte Docker non local est configuré.';
  }
  return null;
}

/** Parse les options explicites acceptées par `pnpm dev:full`. */
export function parseDevArgs(args = process.argv.slice(2)) {
  let noWorker = false;
  let seed = false;

  for (const arg of args) {
    if (arg === '--') continue;
    if (arg === '--no-worker') {
      noWorker = true;
      continue;
    }
    if (arg === '--seed') {
      seed = true;
      continue;
    }
    throw new Error('option inconnue ; utilisez --seed, --no-worker ou aucune option.');
  }

  return { noWorker, seed };
}

function isChildRunning(child) {
  return child?.exitCode === null && child?.signalCode === null;
}

function sendProcessGroupSignal(child, signal) {
  if (
    !POSIX_PROCESS_GROUPS ||
    !MANAGED_PROCESS_GROUPS.has(child) ||
    typeof child?.pid !== 'number' ||
    child.pid <= 0
  ) {
    return false;
  }

  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    // Le groupe peut disparaître entre les contrôles ; tenter le PID direct.
    return false;
  }
}

function isManagedProcessGroupRunning(child) {
  if (
    !POSIX_PROCESS_GROUPS ||
    !MANAGED_PROCESS_GROUPS.has(child) ||
    typeof child?.pid !== 'number' ||
    child.pid <= 0
  ) {
    return false;
  }

  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function sendChildSignal(child, signal) {
  if (sendProcessGroupSignal(child, signal)) return true;
  if (!isChildRunning(child)) return false;

  try {
    return child.kill(signal);
  } catch {
    // Le processus peut s'être terminé entre les deux contrôles.
    return false;
  }
}

export function runCommand(command, args, options = {}) {
  const { timeoutMs, signal, ...spawnOptions } = options ?? {};
  const createProcessGroup = POSIX_PROCESS_GROUPS && spawnOptions.detached !== false;
  const effectiveSpawnOptions = createProcessGroup
    ? { ...spawnOptions, detached: true }
    : spawnOptions;

  return new Promise((resolveResult) => {
    if (signal?.aborted) {
      resolveResult({ ok: false, interrupted: true });
      return;
    }

    let child;
    try {
      child = spawn(command, args, effectiveSpawnOptions);
      if (createProcessGroup) MANAGED_PROCESS_GROUPS.add(child);
    } catch (error) {
      resolveResult({ ok: false, errorCode: error?.code });
      return;
    }

    let settled = false;
    let stopReason = null;
    let timeoutHandle;
    let graceHandle;
    let disappearancePollHandle;
    let disappearanceDeadline;
    let removeAbortListener = () => {};
    let removeChildListeners = () => {};
    let removeOutputListeners = () => {};
    let capturedStdout = false;
    let capturedStderr = false;
    let stdout = '';
    let stderr = '';
    const onStdoutData = (chunk) => {
      stdout += chunk;
    };
    const onStderrData = (chunk) => {
      stderr += chunk;
    };

    if (child.stdout) {
      capturedStdout = true;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', onStdoutData);
    }
    if (child.stderr) {
      capturedStderr = true;
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', onStderrData);
    }
    removeOutputListeners = () => {
      child.stdout?.removeListener('data', onStdoutData);
      child.stderr?.removeListener('data', onStderrData);
    };

    const clearCommandTimers = () => {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      if (graceHandle !== undefined) {
        clearTimeout(graceHandle);
        graceHandle = undefined;
      }
      if (disappearancePollHandle !== undefined) {
        clearTimeout(disappearancePollHandle);
        disappearancePollHandle = undefined;
      }
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearCommandTimers();
      removeAbortListener();
      removeChildListeners();
      removeOutputListeners();
      const output = { ...result };
      if (capturedStdout) output.stdout = stdout;
      if (capturedStderr) output.stderr = stderr;
      resolveResult(output);
    };
    const stopResult = () =>
      stopReason === 'interrupted'
        ? { ok: false, interrupted: true }
        : { ok: false, timedOut: true };
    const waitForProcessGroupDisappearance = () => {
      if (settled) return;
      if (!isManagedProcessGroupRunning(child)) {
        finish(stopResult());
        return;
      }

      const remainingMs = (disappearanceDeadline ?? 0) - Date.now();
      if (remainingMs <= 0) {
        finish(stopResult());
        return;
      }

      disappearancePollHandle = setTimeout(
        () => {
          disappearancePollHandle = undefined;
          waitForProcessGroupDisappearance();
        },
        Math.min(PROCESS_GROUP_DISAPPEARANCE_POLL_MS, remainingMs),
      );
    };
    const forceStop = () => {
      if (settled) return;
      sendChildSignal(child, 'SIGKILL');

      if (!isManagedProcessGroupRunning(child)) {
        finish(stopResult());
        return;
      }

      disappearanceDeadline = Date.now() + PROCESS_GROUP_DISAPPEARANCE_TIMEOUT_MS;
      waitForProcessGroupDisappearance();
    };
    const beginStop = (reason) => {
      if (settled || stopReason !== null) return;
      stopReason = reason;

      if (!sendChildSignal(child, 'SIGTERM')) {
        if (isManagedProcessGroupRunning(child)) {
          forceStop();
        } else {
          finish(stopResult());
        }
        return;
      }

      graceHandle = setTimeout(() => {
        graceHandle = undefined;
        forceStop();
      }, COMMAND_TIMEOUT_GRACE_MS);
    };
    const onAbort = () => beginStop('interrupted');

    const onChildError = (error) => {
      if (stopReason !== null) {
        if (!isManagedProcessGroupRunning(child)) finish(stopResult());
        return;
      }
      finish({ ok: false, errorCode: error?.code });
    };
    const onChildClose = (code) => {
      if (stopReason !== null) {
        if (!isManagedProcessGroupRunning(child)) finish(stopResult());
        return;
      }
      finish({ ok: code === 0 });
    };
    removeChildListeners = () => {
      child.removeListener('error', onChildError);
      child.removeListener('close', onChildClose);
    };
    child.once('error', onChildError);
    child.once('close', onChildClose);

    if (!settled && signal?.addEventListener) {
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }

    if (!settled && typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)) {
      timeoutHandle = setTimeout(() => {
        timeoutHandle = undefined;
        beginStop('timedOut');
      }, timeoutMs);
    }
  });
}

function getContextName(output) {
  if (typeof output !== 'string') return null;
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length === 1 ? lines[0] : null;
}

async function inspectDockerContext(environment = process.env, signal) {
  const inspectionEnvironment = createDockerInspectionEnvironment(environment);
  const contextShow = await runCommand('docker', ['context', 'show'], {
    cwd: REPOSITORY_ROOT,
    env: inspectionEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeoutMs: DOCKER_CONTEXT_INSPECTION_TIMEOUT_MS,
    signal,
  });
  if (!contextShow.ok) {
    if (contextShow.interrupted || signal?.aborted) return { status: 'interrupted' };
    return contextShow.errorCode === 'ENOENT' ? { status: 'missing' } : { status: 'unavailable' };
  }

  const contextName = getContextName(contextShow.stdout);
  if (!contextName || !isAllowedDockerContext(contextName)) {
    return { status: 'unavailable' };
  }
  if (
    inspectionEnvironment.DOCKER_CONTEXT !== undefined &&
    inspectionEnvironment.DOCKER_CONTEXT !== contextName
  ) {
    return { status: 'unavailable' };
  }

  const contextInspect = await runCommand('docker', ['context', 'inspect', contextName], {
    cwd: REPOSITORY_ROOT,
    env: inspectionEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeoutMs: DOCKER_CONTEXT_INSPECTION_TIMEOUT_MS,
    signal,
  });
  if (!contextInspect.ok) {
    return contextInspect.interrupted || signal?.aborted
      ? { status: 'interrupted' }
      : { status: 'unavailable' };
  }

  const validation = validateDockerContextDetails(contextName, contextInspect.stdout);
  return validation.ok
    ? { status: 'available', contextName: validation.contextName, endpoint: validation.endpoint }
    : { status: 'unavailable' };
}

/**
 * Construit des candidats Compose purs à partir de l'état Docker déjà inspecté.
 * L'environnement est copié afin que le même endpoint local inspecté soit réutilisable
 * pour la détection, le démarrage et le healthcheck ; le contexte sert uniquement à
 * l'inspection préalable.
 */
export function getComposeCandidates(dockerContext, environment = {}) {
  const inheritedEnvironment = createDockerEnvironment(environment);

  if (dockerContext?.status === 'available') {
    const contextName = dockerContext.contextName;
    const endpoint = dockerContext.endpoint;
    if (
      typeof contextName !== 'string' ||
      !isAllowedDockerContext(contextName) ||
      !isLocalDockerEndpoint(endpoint)
    ) {
      return [];
    }

    const pluginEnvironment = { ...inheritedEnvironment, DOCKER_HOST: endpoint };
    delete pluginEnvironment.DOCKER_CONTEXT;

    const standaloneEnvironment = { ...inheritedEnvironment, DOCKER_HOST: endpoint };
    delete standaloneEnvironment.DOCKER_CONTEXT;

    return [
      {
        command: 'docker',
        args: ['compose'],
        env: pluginEnvironment,
      },
      {
        command: 'docker-compose',
        args: [],
        env: standaloneEnvironment,
      },
    ];
  }

  return [];
}

function runCompose(compose, args, options = {}) {
  return runCommand(compose.command, [...compose.args, ...args], {
    ...options,
    env: createDockerEnvironment(compose.env),
  });
}

async function detectCompose(candidates, signal) {
  for (const candidate of candidates) {
    if (signal?.aborted) return null;

    const result = await runCompose(candidate, ['version'], {
      cwd: REPOSITORY_ROOT,
      stdio: 'ignore',
      timeoutMs: COMPOSE_DETECTION_TIMEOUT_MS,
      signal,
    });
    if (result.interrupted || signal?.aborted) return null;
    if (result.ok) {
      return candidate;
    }
  }

  return null;
}

function wait(ms, signal) {
  return new Promise((resolveResult) => {
    if (signal?.aborted) {
      resolveResult();
      return;
    }

    let settled = false;
    let timeoutHandle;
    let removeAbortListener = () => {};
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      removeAbortListener();
      resolveResult();
    };
    const onAbort = () => finish();

    if (signal?.addEventListener) {
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    }
    timeoutHandle = setTimeout(finish, ms);
  });
}

function canConnect(host, port, timeoutMs, signal) {
  return new Promise((resolveResult) => {
    if (signal?.aborted) {
      resolveResult(false);
      return;
    }

    let settled = false;
    let removeAbortListener = () => {};
    const socket = createConnection({ host, port });

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      removeAbortListener();
      resolveResult(ok);
    };
    const onAbort = () => finish(false);

    if (signal?.addEventListener) {
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) finish(false);
    }

    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

async function waitForPostgres(compose, signal) {
  const deadline = Date.now() + POSTGRES_WAIT_TIMEOUT_MS;
  let attempts = 0;

  while (attempts < POSTGRES_MAX_ATTEMPTS && Date.now() < deadline) {
    if (signal?.aborted) return { ok: false, interrupted: true };

    attempts += 1;
    const remainingMs = Math.max(1, deadline - Date.now());
    const tcpReady = await canConnect(
      POSTGRES_HOST,
      POSTGRES_PORT,
      Math.min(POSTGRES_CONNECT_TIMEOUT_MS, remainingMs),
      signal,
    );
    if (signal?.aborted) return { ok: false, interrupted: true };

    if (tcpReady && Date.now() < deadline) {
      const healthcheckTimeoutMs = Math.min(
        POSTGRES_HEALTHCHECK_TIMEOUT_MS,
        Math.max(1, deadline - Date.now()),
      );
      const healthcheck = await runCompose(
        compose,
        [
          '-f',
          COMPOSE_FILE,
          'exec',
          '-T',
          'postgres',
          'pg_isready',
          '-U',
          'uttily',
          '-d',
          'uttily',
        ],
        {
          cwd: REPOSITORY_ROOT,
          stdio: 'ignore',
          timeoutMs: healthcheckTimeoutMs,
          signal,
        },
      );
      if (healthcheck.interrupted || signal?.aborted) {
        return { ok: false, interrupted: true };
      }
      if (healthcheck.ok) return { ok: true, interrupted: false };
    }

    const delayMs = Math.min(POSTGRES_RETRY_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (delayMs > 0) await wait(delayMs, signal);
  }

  return signal?.aborted ? { ok: false, interrupted: true } : { ok: false, interrupted: false };
}

function spawnManagedChild(command, args, env) {
  let child;
  try {
    child = spawn(command, args, {
      ...(POSIX_PROCESS_GROUPS ? { detached: true } : {}),
      env,
      stdio: 'inherit',
    });
    if (POSIX_PROCESS_GROUPS) MANAGED_PROCESS_GROUPS.add(child);
  } catch {
    return {
      child: null,
      completion: Promise.resolve({ ok: false }),
    };
  }

  const completion = new Promise((resolveResult) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };

    child.once('error', () => finish({ ok: false }));
    child.once('close', (code, signal) => finish({ ok: code === 0, signal }));
  });

  return { child, completion };
}

function stopChild(child) {
  sendChildSignal(child, 'SIGTERM');
}

async function stopChildren(children) {
  for (const managedChild of children) {
    stopChild(managedChild.child);
  }

  const allCompleted = Promise.all(children.map((managedChild) => managedChild.completion));
  let shutdownTimer;
  let timedOut = false;
  const timeout = new Promise((resolveResult) => {
    shutdownTimer = setTimeout(() => {
      timedOut = true;
      resolveResult();
    }, CHILD_SHUTDOWN_TIMEOUT_MS);
  });
  const clearShutdownTimer = () => {
    if (shutdownTimer === undefined) return;
    clearTimeout(shutdownTimer);
    shutdownTimer = undefined;
  };

  allCompleted.then(clearShutdownTimer, clearShutdownTimer);
  const forceStop = () => {
    for (const managedChild of children) {
      sendChildSignal(managedChild.child, 'SIGKILL');
    }
  };

  try {
    await Promise.race([allCompleted, timeout]);

    if (timedOut) {
      forceStop();
    } else if (children.some((managedChild) => isManagedProcessGroupRunning(managedChild.child))) {
      // Le leader peut avoir fermé alors qu'un descendant est encore dans le groupe.
      await wait(COMMAND_TIMEOUT_GRACE_MS);
      forceStop();
    }

    await allCompleted;
  } finally {
    clearShutdownTimer();
  }
}

async function superviseChildren(children, signal) {
  if (children.length === 0) return 0;

  let stopping = false;
  let interrupted = Boolean(signal?.aborted);
  let failed = false;
  let closedCount = 0;
  let stopPromise = Promise.resolve();
  let removeAbortListener = () => {};
  let resolveAllClosed;
  const allClosed = new Promise((resolveResult) => {
    resolveAllClosed = resolveResult;
  });

  const requestStop = () => {
    if (stopping) return;
    stopping = true;
    stopPromise = stopChildren(children);
  };

  const onAbort = () => {
    if (!failed) interrupted = true;
    requestStop();
  };
  if (signal?.addEventListener) {
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    if (signal.aborted) onAbort();
  }

  for (const managedChild of children) {
    managedChild.completion.then(() => {
      closedCount += 1;
      if (!stopping && !signal?.aborted) {
        failed = true;
        requestStop();
      }
      if (closedCount === children.length) resolveAllClosed();
    });
  }

  try {
    await allClosed;
    await stopPromise;
  } finally {
    removeAbortListener();
  }

  if (failed) return 1;
  if (interrupted) return 0;
  return 1;
}

/** Exécute le workflow local complet et retourne son code de sortie. */
export async function runDev(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseDevArgs(args);
  } catch (error) {
    console.error(`dev:full: ${error instanceof Error ? error.message : 'options invalides.'}`);
    return 1;
  }

  const abortController = new AbortController();
  const { signal } = abortController;
  const onSignal = () => abortController.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    if (signal.aborted) return 0;

    const dockerEnvironment = createDockerEnvironment(process.env);
    const dockerEnvironmentError = getDockerEnvironmentError(dockerEnvironment);
    if (dockerEnvironmentError) {
      console.error(`dev:full: environnement Docker refusé — ${dockerEnvironmentError}`);
      return 1;
    }

    let localEnvironment;
    try {
      // Cette validation intervient avant toute détection ou commande externe.
      localEnvironment = createLocalEnvironment(process.env);
    } catch (error) {
      console.error(
        `dev:full: environnement refusé — ${
          error instanceof Error ? error.message : 'configuration locale invalide.'
        }`,
      );
      return 1;
    }
    if (signal.aborted) return 0;

    const dockerContext = await inspectDockerContext(dockerEnvironment, signal);
    if (signal.aborted || dockerContext.status === 'interrupted') return 0;

    if (dockerContext.status !== 'available') {
      console.error('dev:full: impossible d’inspecter le contexte Docker local.');
      return 1;
    }

    const compose = await detectCompose(
      getComposeCandidates(dockerContext, dockerEnvironment),
      signal,
    );
    if (signal.aborted) return 0;
    if (!compose) {
      console.error('dev:full: aucun binaire Docker Compose disponible.');
      return 1;
    }

    const postgresStart = await runCompose(compose, ['-f', COMPOSE_FILE, 'up', '-d', 'postgres'], {
      cwd: REPOSITORY_ROOT,
      stdio: 'ignore',
      timeoutMs: COMPOSE_UP_TIMEOUT_MS,
      signal,
    });
    if (postgresStart.interrupted || signal.aborted) return 0;
    if (!postgresStart.ok) {
      console.error('dev:full: impossible de démarrer PostgreSQL local avec Docker Compose.');
      return 1;
    }

    const postgresReadiness = await waitForPostgres(compose, signal);
    if (postgresReadiness.interrupted || signal.aborted) return 0;
    if (!postgresReadiness.ok) {
      console.error('dev:full: PostgreSQL local n’est pas prêt dans le délai prévu.');
      return 1;
    }
    console.log('dev:full: PostgreSQL local prêt.');

    const migrations = await runCommand('pnpm', ['--filter', '@uttily/database', 'db:migrate'], {
      cwd: REPOSITORY_ROOT,
      env: localEnvironment,
      stdio: 'inherit',
      timeoutMs: MIGRATIONS_TIMEOUT_MS,
      signal,
    });
    if (migrations.interrupted || signal.aborted) return 0;
    if (!migrations.ok) {
      console.error('dev:full: les migrations locales ont échoué.');
      return 1;
    }
    console.log('dev:full: migrations locales appliquées.');
    if (signal.aborted) return 0;

    if (options.seed) {
      const seed = await runCommand('pnpm', ['--filter', '@uttily/database', 'db:seed:local'], {
        cwd: REPOSITORY_ROOT,
        env: localEnvironment,
        stdio: 'inherit',
        timeoutMs: MIGRATIONS_TIMEOUT_MS,
        signal,
      });
      if (seed.interrupted || signal.aborted) return 0;
      if (!seed.ok) {
        console.error('dev:full: le seed local a échoué.');
        return 1;
      }
      console.log('dev:full: seed local appliqué.');
    }
    if (signal.aborted) return 0;

    const children = [];
    try {
      children.push(spawnManagedChild('pnpm', ['--filter', 'web', 'dev'], localEnvironment));
      if (!options.noWorker && !signal.aborted) {
        children.push(
          spawnManagedChild('pnpm', ['--filter', '@uttily/worker', 'dev:local'], localEnvironment),
        );
      }
    } catch {
      await stopChildren(children);
      console.error('dev:full: impossible de démarrer les processus de développement.');
      return 1;
    }

    if (!signal.aborted) {
      console.log('dev:full: Web disponible (Next.js en développement).');
      console.log(`dev:full: worker fake ${options.noWorker ? 'désactivé' : 'activé'}.`);
    }

    const exitCode = await superviseChildren(children, signal);
    if (exitCode !== 0) {
      console.error('dev:full: un processus de développement s’est arrêté de manière inattendue.');
    } else {
      console.log('dev:full: Web et worker arrêtés ; PostgreSQL local reste actif.');
    }
    return exitCode;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

function isMainModule() {
  return (
    process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
  );
}

if (isMainModule()) {
  runDev()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      console.error('dev:full: échec inattendu du workflow local.');
      process.exitCode = 1;
    });
}
