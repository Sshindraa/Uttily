import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const runbooksDirectory = join(repositoryRoot, 'docs', 'runbooks');
const read = (relativePath) => readFile(join(repositoryRoot, relativePath), 'utf8');

const runbookNames = [
  '20b-stripe-webhook-outage.md',
  '20b-payment-succeeded-booking-not-confirmed.md',
  '20b-refund-provider-ambiguous.md',
  '20b-workers-crons-stopped.md',
  '20b-database-unavailable.md',
  '20b-vercel-deployment-broken.md',
  '20b-secret-compromised.md',
  '20b-suspected-overbooking.md',
];

test('the eight 20-B runbooks are present and operationally structured', async () => {
  const entries = await readdir(runbooksDirectory);
  for (const name of runbookNames) {
    assert.ok(entries.includes(name), `runbook missing: ${name}`);
    const content = await read(`docs/runbooks/${name}`);
    for (const heading of [
      '## Symptôme',
      '## Diagnostic',
      '## Action sûre',
      '## Action interdite',
      '## Replay / recovery existant',
      '## Escalade',
    ]) {
      assert.match(content, new RegExp(heading.replaceAll('/', '\/')));
    }
    assert.doesNotMatch(content, /rm\s+-rf/);
    assert.doesNotMatch(content, /base de données de production.*restore/i);
  }
});

test('the restore drill is fail-closed and uses dump/restore tooling', async () => {
  const content = await read('packages/database/scripts/restore-drill.mjs');
  assert.match(content, /UTTILY_RECOVERY_DRILL/);
  assert.match(content, /NODE_ENV.*production/);
  assert.match(content, /pg_dump/);
  assert.match(content, /pg_restore/);
  assert.match(content, /DATABASE_NAME_PATTERN/);
  assert.match(content, /DROP DATABASE IF EXISTS/);
  assert.doesNotMatch(content, /DROP DATABASE IF EXISTS \"\$\{.*databaseUrl/);
});

test('the recovery documentation separates proof, target, and provider dependency', async () => {
  const content = await read('docs/implementation/chantier-20b-recovery.md');
  for (const heading of [
    '## Statut de preuve',
    '## B1 — Restore drill',
    '## B2 — Migrations',
    '## B3 — Runbooks',
    '## B5 — Rotation des secrets',
    'PROVENUE_PAR_DRILL',
    'DEPENDANCE_PROVIDER',
    'A_CONFIRMER',
  ]) {
    assert.match(content, new RegExp(heading.replaceAll('_', '\\_')));
  }
  assert.doesNotMatch(content, /SLA commercial|garantie de disponibilité commerciale/i);
});
