import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CRON_PATHS, resolveCronTargetUrl, runScheduledJobs } from './index.mjs';

test('normalise une URL HTTPS publique sans query ni slash final', () => {
  assert.equal(
    resolveCronTargetUrl('https://uttily-staging-uttily.vercel.app/base/?ignored=true#fragment'),
    'https://uttily-staging-uttily.vercel.app/base',
  );
});

test('refuse une URL locale ou non HTTPS', () => {
  assert.throws(() => resolveCronTargetUrl('http://localhost:3000'));
  assert.throws(() => resolveCronTargetUrl('https://127.0.0.1'));
  assert.throws(() => resolveCronTargetUrl('http://staging.example'));
});

test('refuse une cible ou un secret absent', async () => {
  await assert.rejects(() =>
    runScheduledJobs({ CRON_SECRET: 'secret' }, async () => new Response()),
  );
  await assert.rejects(() =>
    runScheduledJobs(
      { CRON_TARGET_URL: 'https://staging.example', CRON_SECRET: '' },
      async () => new Response(),
    ),
  );
});

test('appelle les quatre routes séquentiellement avec le secret partagé', async () => {
  const calls = [];
  const logs = [];
  const results = await runScheduledJobs(
    { CRON_TARGET_URL: 'https://staging.example/', CRON_SECRET: 'test-secret' },
    async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 200 });
    },
    { info: (_event, result) => logs.push(result), error: () => assert.fail('unexpected error') },
  );

  assert.deepEqual(
    calls.map((call) => call.url),
    CRON_PATHS.map((path) => `https://staging.example${path}`),
  );
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-secret');
  assert.equal(calls[0].init.headers['User-Agent'], 'uttily-staging-cron/1');
  assert.deepEqual(
    results,
    CRON_PATHS.map((path) => ({ path, status: 200, ok: true })),
  );
  assert.equal(logs.length, CRON_PATHS.length);
});

test('appelle toutes les routes et échoue si une route répond en erreur', async () => {
  const calls = [];
  const logs = [];
  await assert.rejects(
    () =>
      runScheduledJobs(
        { CRON_TARGET_URL: 'https://staging.example', CRON_SECRET: 'test-secret' },
        async (url) => {
          calls.push(url);
          return new Response(null, { status: url.endsWith(CRON_PATHS[1]) ? 500 : 200 });
        },
        { info: () => {}, error: (_event, result) => logs.push(result) },
      ),
    /route cron staging a échoué/,
  );
  assert.equal(calls.length, CRON_PATHS.length);
  assert.equal(logs.length, 1);
});
