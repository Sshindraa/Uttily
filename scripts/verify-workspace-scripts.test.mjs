import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { tmpdir } from 'node:os';

import {
  extractScriptFileReferences,
  findMissingScriptFiles,
  verifyWorkspaceScripts,
} from './verify-workspace-scripts.mjs';

test('extrait les fichiers locaux et ignore les motifs globaux', () => {
  assert.deepEqual(
    extractScriptFileReferences(
      "vitest run --exclude 'src/e2e/**' && node scripts/dev-local.mjs && node build.mjs",
    ),
    ['scripts/dev-local.mjs', 'build.mjs'],
  );
});

test('toutes les références de scripts des manifests existent', () => {
  assert.deepEqual(findMissingScriptFiles(), []);
  assert.equal(verifyWorkspaceScripts(), true);
});

test('signale une référence de script manquante', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'uttily-script-check-'));
  try {
    mkdirSync(join(fixtureRoot, 'apps'));
    mkdirSync(join(fixtureRoot, 'packages'));
    writeFileSync(
      join(fixtureRoot, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { missing: 'node scripts/missing.mjs' } }),
    );

    assert.deepEqual(findMissingScriptFiles(fixtureRoot), [
      {
        packageName: 'fixture',
        scriptName: 'missing',
        reference: 'scripts/missing.mjs',
        target: 'scripts/missing.mjs',
      },
    ]);
    assert.throws(() => verifyWorkspaceScripts(fixtureRoot), /fixture#missing/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
