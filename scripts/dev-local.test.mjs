import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCAL_DATABASE_URL,
  LOCAL_DEV_PUBLIC_SEARCH_CURSOR_SECRET,
  LOCAL_PUBLIC_APP_URL,
  createDockerEnvironment,
  createDockerInspectionEnvironment,
  createLocalEnvironment,
  getComposeCandidates,
  getDockerEnvironmentError,
  isAllowedDockerContext,
  isLocalDatabaseUrl,
  isRemoteDockerHost,
  parseDevArgs,
  runCommand,
  validateDockerContext,
} from './dev-local.mjs';

const LOCAL_PROVIDER_VARIABLES = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'RESEND_BOOKING_CONFIRMED_TEMPLATE_ID',
];
const LOCAL_WEBHOOK_VARIABLES = [
  'CLERK_WEBHOOK_SECRET',
  'STRIPE_PLATFORM_WEBHOOK_SECRET',
  'STRIPE_CONNECT_WEBHOOK_SECRET',
];
const INSPECTED_DOCKER_ENDPOINT = 'unix:///tmp/uttily-docker.sock';
const VALID_CLERK_KEYS = {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: `pk_test_${'A'.repeat(32)}`,
  CLERK_SECRET_KEY: `sk_test_${'B'.repeat(32)}`,
};

function createTestLocalEnvironment(overrides = {}) {
  return createLocalEnvironment({ ...VALID_CLERK_KEYS, ...overrides });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolveResult) => setTimeout(resolveResult, 20));
  }
  return !isProcessAlive(pid);
}

test('accepte les URLs PostgreSQL locales', () => {
  const localUrls = [
    'postgresql://uttily:uttily@localhost:5432/uttily',
    'postgres://uttily:uttily@127.0.0.1:5432/uttily',
    'postgresql://uttily:uttily@[::1]:5432/uttily',
  ];

  for (const url of localUrls) {
    assert.equal(isLocalDatabaseUrl(url), true, url);
  }
});

test('refuse une URL de base distante', () => {
  const remoteUrl = 'postgresql://uttily:uttily@database.example.invalid:5432/uttily';

  assert.equal(isLocalDatabaseUrl(remoteUrl), false);
  assert.throws(
    () => createTestLocalEnvironment({ DATABASE_URL: remoteUrl }),
    /DATABASE_URL doit pointer vers PostgreSQL local/,
  );
});

test('refuse une URL invalide', () => {
  assert.equal(isLocalDatabaseUrl('not-a-database-url'), false);
  assert.throws(
    () => createTestLocalEnvironment({ DATABASE_DIRECT_URL: 'not-a-database-url' }),
    /DATABASE_DIRECT_URL doit pointer vers PostgreSQL local/,
  );
});

test('produit un environnement avec les deux URLs locales fixes', () => {
  const environment = createTestLocalEnvironment({
    KEEP_ME: 'preserved',
    DATABASE_URL: 'postgresql://user:password@localhost:5432/another_database',
    DATABASE_DIRECT_URL: 'postgresql://user:password@[::1]:5432/another_database',
  });

  assert.equal(environment.KEEP_ME, 'preserved');
  assert.equal(environment.DATABASE_URL, LOCAL_DATABASE_URL);
  assert.equal(environment.DATABASE_DIRECT_URL, LOCAL_DATABASE_URL);
});

test('force NODE_ENV development et le marqueur de seed local pour les processus locaux', () => {
  const environment = createTestLocalEnvironment({ NODE_ENV: 'production' });

  assert.equal(environment.NODE_ENV, 'development');
  assert.equal(environment.UTTILY_LOCAL_DEV, '1');
});

test('remplace les origins et le curseur hérités par les valeurs dev/test locales', () => {
  const environment = createTestLocalEnvironment({
    PUBLIC_SEARCH_CURSOR_SECRET: 'parent-cursor-fixture',
    ALLOWED_ORIGINS: 'https://production.example.invalid',
  });

  assert.equal(environment.PUBLIC_SEARCH_CURSOR_SECRET, LOCAL_DEV_PUBLIC_SEARCH_CURSOR_SECRET);
  assert.equal(environment.ALLOWED_ORIGINS, '');
});

test('impose une URL de retour et ne réintroduit pas l’ancien taux de commission', () => {
  const environment = createTestLocalEnvironment({
    PUBLIC_APP_URL: 'https://production.example.invalid',
    PLATFORM_COMMISSION_RATE_BPS: '0',
  });

  assert.equal(environment.PUBLIC_APP_URL, LOCAL_PUBLIC_APP_URL);
  assert.equal(environment.PLATFORM_COMMISSION_RATE_BPS, undefined);
});

test('force Stripe TEST et vide les clés absentes dans l’environnement enfant', () => {
  const environment = createTestLocalEnvironment({
    STRIPE_ENVIRONMENT: 'LIVE',
    PAYMENTS_LIVE_ENABLED: 'true',
  });

  assert.equal(environment.STRIPE_ENVIRONMENT, 'TEST');
  assert.equal(environment.PAYMENTS_LIVE_ENABLED, 'false');
  assert.equal(environment.STRIPE_SECRET_KEY, '');
  assert.equal(environment.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, '');
});

test('accepte les clés Stripe explicitement vides comme une absence', () => {
  const environment = createTestLocalEnvironment({
    STRIPE_SECRET_KEY: '',
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: '',
  });

  assert.equal(environment.STRIPE_SECRET_KEY, '');
  assert.equal(environment.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, '');
});

test('refuse une clé Stripe publique LIVE héritée sans révéler sa valeur', () => {
  const liveKey = 'pk_live_fixture_only';

  assert.throws(
    () => createTestLocalEnvironment({ NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: liveKey }),
    (error) => {
      assert.match(error.message, /configuration Stripe TEST invalide/);
      assert.doesNotMatch(error.message, new RegExp(liveKey));
      return true;
    },
  );
});

test('refuse une clé Stripe secrète LIVE héritée sans révéler sa valeur', () => {
  const liveKey = 'sk_live_fixture_only';

  assert.throws(
    () => createTestLocalEnvironment({ STRIPE_SECRET_KEY: liveKey }),
    (error) => {
      assert.match(error.message, /configuration Stripe TEST invalide/);
      assert.doesNotMatch(error.message, new RegExp(liveKey));
      return true;
    },
  );
});

test('conserve uniquement les clés Stripe TEST validées', () => {
  const environment = createTestLocalEnvironment({
    STRIPE_SECRET_KEY: 'sk_test_fixture_only',
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_fixture_only',
  });

  assert.equal(environment.STRIPE_SECRET_KEY, 'sk_test_fixture_only');
  assert.equal(environment.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, 'pk_test_fixture_only');
});

test('refuse les clés Clerk absentes ou vides', () => {
  assert.throws(
    () => createLocalEnvironment({}),
    (error) => {
      assert.match(
        error.message,
        /configuration Clerk TEST invalide pour NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY/,
      );
      assert.doesNotMatch(error.message, /pk_test_local_dev|sk_test_local_dev/);
      return true;
    },
  );

  assert.throws(
    () => createTestLocalEnvironment({ CLERK_SECRET_KEY: '' }),
    /configuration Clerk TEST invalide pour CLERK_SECRET_KEY/,
  );
});

test('refuse les placeholders Clerk TEST trop courts', () => {
  for (const [variable, prefix] of [
    ['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test_'],
    ['CLERK_SECRET_KEY', 'sk_test_'],
  ]) {
    const placeholder = `${prefix}local_dev`;
    assert.throws(
      () => createTestLocalEnvironment({ [variable]: placeholder }),
      (error) => {
        assert.match(error.message, /configuration Clerk TEST invalide/);
        assert.doesNotMatch(error.message, new RegExp(placeholder));
        return true;
      },
    );
  }
});

test('refuse une clé Clerk publique LIVE héritée sans révéler sa valeur', () => {
  const liveKey = 'pk_live_fixture_only';

  assert.throws(
    () => createTestLocalEnvironment({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: liveKey }),
    (error) => {
      assert.match(error.message, /configuration Clerk TEST invalide/);
      assert.doesNotMatch(error.message, new RegExp(liveKey));
      return true;
    },
  );
});

test('refuse une clé Clerk secrète LIVE héritée sans révéler sa valeur', () => {
  const liveKey = 'sk_live_fixture_only';

  assert.throws(
    () => createTestLocalEnvironment({ CLERK_SECRET_KEY: liveKey }),
    (error) => {
      assert.match(error.message, /configuration Clerk TEST invalide/);
      assert.doesNotMatch(error.message, new RegExp(liveKey));
      return true;
    },
  );
});

test('accepte et transmet des clés Clerk TEST synthétiques suffisamment longues', () => {
  const environment = createLocalEnvironment(VALID_CLERK_KEYS);

  assert.equal(
    environment.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    VALID_CLERK_KEYS.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  );
  assert.equal(environment.CLERK_SECRET_KEY, VALID_CLERK_KEYS.CLERK_SECRET_KEY);
  assert.equal(environment.CRON_SECRET, 'dev-cron-secret-local');
});

test('neutralise les webhooks hérités et fixe le cron local avec des clés Clerk TEST valides', () => {
  const environment = createTestLocalEnvironment({
    ...Object.fromEntries(
      LOCAL_WEBHOOK_VARIABLES.map((variable) => [variable, 'inherited-secret']),
    ),
    CRON_SECRET: 'inherited-cron-secret',
  });

  for (const variable of LOCAL_WEBHOOK_VARIABLES) {
    assert.equal(environment[variable], '', variable);
  }
  assert.equal(environment.CRON_SECRET, 'dev-cron-secret-local');
});

test('transmet les sept variables R2 et Resend comme chaînes vides', () => {
  const environment = createTestLocalEnvironment({});

  for (const variable of LOCAL_PROVIDER_VARIABLES) {
    assert.equal(Object.hasOwn(environment, variable), true, variable);
    assert.equal(environment[variable], '', variable);
  }
});

test('neutralise les valeurs R2 et Resend héritées dans l’environnement enfant', () => {
  const parentEnvironment = Object.fromEntries(
    LOCAL_PROVIDER_VARIABLES.map((variable) => [variable, 'fixture-only-parent-value']),
  );

  const environment = createTestLocalEnvironment({
    ...parentEnvironment,
    STRIPE_SECRET_KEY: 'sk_test_fixture_only',
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_fixture_only',
  });

  for (const variable of LOCAL_PROVIDER_VARIABLES) {
    assert.equal(Object.hasOwn(environment, variable), true, variable);
    assert.equal(environment[variable], '', variable);
  }
  assert.equal(environment.STRIPE_SECRET_KEY, 'sk_test_fixture_only');
  assert.equal(environment.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, 'pk_test_fixture_only');
});

test('filtre l’environnement Docker et conserve PATH et les variables autorisées', () => {
  const environment = createDockerEnvironment({
    PATH: '/usr/bin',
    HOME: '/tmp/uttily-home',
    USER: 'uttily',
    TMPDIR: '/tmp',
    XDG_CONFIG_HOME: '/tmp/uttily-config',
    DOCKER_CONFIG: '/tmp/uttily-docker',
    DOCKER_CERT_PATH: '/tmp/uttily-certs',
    DOCKER_TLS_VERIFY: '1',
    DOCKER_HOST: 'unix:///tmp/uttily-docker.sock',
    DOCKER_CONTEXT: 'colima',
    COMPOSE_PROJECT_NAME: 'uttily-local',
    COMPOSE_PROFILES: 'local',
    DATABASE_URL: 'postgresql://app-secret.invalid/uttily',
    APP_FAKE_SECRET: 'fixture-only-secret',
  });

  assert.deepEqual(environment, {
    PATH: '/usr/bin',
    HOME: '/tmp/uttily-home',
    USER: 'uttily',
    TMPDIR: '/tmp',
    XDG_CONFIG_HOME: '/tmp/uttily-config',
    DOCKER_CONFIG: '/tmp/uttily-docker',
    DOCKER_CERT_PATH: '/tmp/uttily-certs',
    DOCKER_TLS_VERIFY: '1',
    DOCKER_HOST: 'unix:///tmp/uttily-docker.sock',
    DOCKER_CONTEXT: 'colima',
    COMPOSE_PROJECT_NAME: 'uttily-local',
    COMPOSE_PROFILES: 'local',
  });
  assert.equal(environment.APP_FAKE_SECRET, undefined);
  assert.equal(environment.DATABASE_URL, undefined);
});

test('retire DOCKER_HOST pendant l’inspection quand un contexte local explicite est défini', () => {
  const environment = createDockerInspectionEnvironment({
    PATH: '/usr/bin',
    DOCKER_CONTEXT: 'colima',
    DOCKER_HOST: 'unix:///tmp/contradictory-docker.sock',
    KEEP_ME: 'preserved',
  });

  assert.deepEqual(environment, {
    PATH: '/usr/bin',
    DOCKER_CONTEXT: 'colima',
  });
});

test('conserve DOCKER_HOST pour l’inspection du contexte actif sans contexte explicite', () => {
  const environment = createDockerInspectionEnvironment({
    PATH: '/usr/bin',
    DOCKER_HOST: 'unix:///tmp/active-docker.sock',
  });

  assert.deepEqual(environment, {
    PATH: '/usr/bin',
    DOCKER_HOST: 'unix:///tmp/active-docker.sock',
  });
});

test('refuse les moteurs Docker explicitement distants sans révéler leur endpoint', () => {
  const remoteEndpoints = [
    'tcp://docker.example.invalid:2376',
    'ssh://docker.example.invalid',
    'http://docker.example.invalid:2375',
    'https://docker.example.invalid',
  ];

  for (const endpoint of remoteEndpoints) {
    assert.equal(isRemoteDockerHost(endpoint), true, endpoint);
    const error = getDockerEnvironmentError({ DOCKER_HOST: endpoint });
    assert.match(error ?? '', /moteur Docker distant/);
    assert.doesNotMatch(error ?? '', /docker\.example\.invalid/);
  }
});

test('autorise les contextes Docker locaux et refuse les autres', () => {
  for (const context of [undefined, 'default', 'colima', 'desktop-linux', 'docker-desktop']) {
    assert.equal(isAllowedDockerContext(context), true, context);
    assert.equal(getDockerEnvironmentError({ DOCKER_CONTEXT: context }), null, context);
  }

  assert.equal(isAllowedDockerContext('production'), false);
  const error = getDockerEnvironmentError({ DOCKER_CONTEXT: 'production' });
  assert.match(error ?? '', /contexte Docker non local/);
  assert.doesNotMatch(error ?? '', /production/);
});

test('refuse un endpoint distant du contexte actif sans DOCKER_CONTEXT', () => {
  const syntheticEnvironment = {};
  const activeContext = syntheticEnvironment.DOCKER_CONTEXT ?? 'default';
  const inspection = JSON.stringify([
    {
      Name: activeContext,
      Endpoints: { docker: { Host: 'ssh://synthetic.invalid' } },
    },
  ]);

  const error = validateDockerContext(activeContext, inspection);
  assert.match(error ?? '', /endpoint Docker distant ou non local/);
  assert.doesNotMatch(error ?? '', /synthetic\.invalid|default/);
});

test('utilise l’endpoint inspecté et neutralise le contexte sur les deux candidats', () => {
  const environment = {
    PATH: '/usr/bin',
    KEEP_ME: 'preserved',
    DOCKER_HOST: 'unix:///tmp/contradictory-docker.sock',
    DOCKER_CONTEXT: 'colima',
  };
  const candidates = getComposeCandidates(
    { status: 'available', contextName: 'colima', endpoint: INSPECTED_DOCKER_ENDPOINT },
    environment,
  );

  assert.deepEqual(candidates, [
    {
      command: 'docker',
      args: ['compose'],
      env: { PATH: '/usr/bin', DOCKER_HOST: INSPECTED_DOCKER_ENDPOINT },
    },
    {
      command: 'docker-compose',
      args: [],
      env: { PATH: '/usr/bin', DOCKER_HOST: INSPECTED_DOCKER_ENDPOINT },
    },
  ]);
  assert.equal(candidates[0].env.DOCKER_HOST, INSPECTED_DOCKER_ENDPOINT);
  assert.equal(candidates[0].env.DOCKER_CONTEXT, undefined);
  assert.equal(candidates[1].env.DOCKER_HOST, INSPECTED_DOCKER_ENDPOINT);
  assert.equal(candidates[1].env.DOCKER_CONTEXT, undefined);
  assert.deepEqual(environment, {
    PATH: '/usr/bin',
    KEEP_ME: 'preserved',
    DOCKER_HOST: 'unix:///tmp/contradictory-docker.sock',
    DOCKER_CONTEXT: 'colima',
  });
});

test('utilise l’endpoint inspecté sur le plugin Docker default', () => {
  const candidates = getComposeCandidates(
    { status: 'available', contextName: 'default', endpoint: INSPECTED_DOCKER_ENDPOINT },
    { PATH: '/usr/bin' },
  );

  assert.deepEqual(candidates[0], {
    command: 'docker',
    args: ['compose'],
    env: { PATH: '/usr/bin', DOCKER_HOST: INSPECTED_DOCKER_ENDPOINT },
  });
  assert.deepEqual(candidates[1], {
    command: 'docker-compose',
    args: [],
    env: { PATH: '/usr/bin', DOCKER_HOST: INSPECTED_DOCKER_ENDPOINT },
  });
});

test('refuse un contexte disponible sans endpoint inspecté', () => {
  assert.deepEqual(
    getComposeCandidates({ status: 'available', contextName: 'colima' }, { PATH: '/usr/bin' }),
    [],
  );
});

test('refuse tout candidat sans contexte Docker local inspecté', () => {
  assert.deepEqual(getComposeCandidates({ status: 'missing' }, { PATH: '/usr/bin' }), []);
  assert.deepEqual(
    getComposeCandidates(
      { status: 'missing' },
      {
        PATH: '/usr/bin',
        HOME: '/tmp/uttily-home',
        DOCKER_CONFIG: '/tmp/uttily-docker-config',
      },
    ),
    [],
  );
  assert.deepEqual(
    getComposeCandidates({ status: 'missing' }, { PATH: '/usr/bin', DOCKER_CONTEXT: 'colima' }),
    [],
  );
  assert.deepEqual(
    getComposeCandidates(
      { status: 'missing' },
      { PATH: '/usr/bin', DOCKER_HOST: 'local-override' },
    ),
    [],
  );
});

test('termine une commande externe bornée après SIGTERM', async () => {
  const result = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
    stdio: 'ignore',
    timeoutMs: 100,
  });

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
});

test('force la fin d’une commande qui ignore SIGTERM après une courte grâce', async () => {
  const timeoutMs = 75;
  const startedAt = Date.now();
  const result = await runCommand(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    {
      stdio: 'ignore',
      timeoutMs,
    },
  );
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(elapsedMs >= timeoutMs + 150);
  assert.ok(elapsedMs < 2_000);
});

test(
  'tue le descendant persistant après la fermeture du leader sur SIGTERM',
  { skip: process.platform === 'win32', timeout: 5_000 },
  async () => {
    const timeoutMs = 150;
    const descendantScript =
      "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);";
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: ['ignore', 'pipe', 'ignore'] });`,
      "descendant.stdout.once('data', () => process.stdout.write(String(descendant.pid)));",
      "process.on('SIGTERM', () => process.exit(0));",
      'setInterval(() => {}, 1000);',
    ].join('');
    let descendantPid;

    try {
      const startedAt = Date.now();
      const result = await runCommand(process.execPath, ['-e', parentScript], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeoutMs,
      });
      const elapsedMs = Date.now() - startedAt;
      descendantPid = Number(result.stdout?.trim());

      assert.equal(result.ok, false);
      assert.equal(result.timedOut, true);
      assert.ok(elapsedMs < 2_000);
      assert.equal(Number.isInteger(descendantPid) && descendantPid > 0, true);
      assert.equal(await waitForProcessExit(descendantPid, 2_000), true);
    } finally {
      if (Number.isInteger(descendantPid) && descendantPid > 0 && isProcessAlive(descendantPid)) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {}
      }
    }
  },
);

test('interrompt une commande longue avec AbortSignal et une grâce bornée', async () => {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 75);
  const startedAt = Date.now();
  const result = await runCommand(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    {
      stdio: 'ignore',
      signal: controller.signal,
    },
  );
  clearTimeout(abortTimer);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.ok, false);
  assert.equal(result.interrupted, true);
  assert.ok(elapsedMs < 2_000);
});

test('active le worker par défaut et accepte --seed et --no-worker', () => {
  assert.deepEqual(parseDevArgs([]), { noWorker: false, seed: false });
  assert.deepEqual(parseDevArgs(['--no-worker']), { noWorker: true, seed: false });
  assert.deepEqual(parseDevArgs(['--seed']), { noWorker: false, seed: true });
  assert.deepEqual(parseDevArgs(['--seed', '--no-worker']), { noWorker: true, seed: true });
  assert.deepEqual(parseDevArgs(['--no-worker', '--seed']), { noWorker: true, seed: true });
  assert.deepEqual(parseDevArgs(['--', '--seed', '--no-worker']), {
    noWorker: true,
    seed: true,
  });
});
