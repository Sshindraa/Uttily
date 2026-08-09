/**
 * @uttily/worker — Tests du harness de smoke (G5H-C2C-B4 round 3).
 *
 * Ces tests spawnent le harness `scripts/smoke-built-worker.mjs` comme un
 * child process et vérifient :
 * - l'échec propre quand le bundle est absent (exit 2) ;
 * - le timeout ferme quand startWorker ne résout jamais (exit 70) ;
 * - le succès avec terminaison naturelle quand le bundle compilé est présent (exit 0) ;
 * - la détection d'un console.log synchrone pendant l'import (exit 1) ;
 * - la détection d'un console.log différée via setImmediate pendant l'import (exit 1) ;
 * - la validation stricte de --timeout-ms (exit 64, échec immédiat, sans interpolation) ;
 * - l'absence de fixtures dans dist/ (seuls index.js et index.js.map).
 *
 * Un build frais est exécuté en beforeAll pour garantir un dist/index.js
 * à jour. Aucun appel réel à PostgreSQL/R2/Resend.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const harnessPath = resolve(scriptDir, '..', 'scripts', 'smoke-built-worker.mjs');
const buildScriptPath = resolve(scriptDir, '..', 'build.mjs');
const workerRoot = resolve(scriptDir, '..');
const distDir = resolve(scriptDir, '..', 'dist');
const hangingFixturePath = resolve(scriptDir, '..', 'scripts', 'fixtures', 'hanging-bundle.mjs');
const syncConsoleFixturePath = resolve(
  scriptDir,
  '..',
  'scripts',
  'fixtures',
  'sync-console-bundle.mjs',
);
const deferredConsoleFixturePath = resolve(
  scriptDir,
  '..',
  'scripts',
  'fixtures',
  'deferred-console-bundle.mjs',
);

interface HarnessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Spawn `node <harnessPath>` avec les args donnés et retourne le résultat.
 * Rejette si le process dépasse le timeout (ms).
 */
function runHarness(args: string[], timeoutMs: number): Promise<HarnessResult> {
  return new Promise<HarnessResult>((resolvePromise, reject) => {
    const start = Date.now();
    const child = spawn('node', [harnessPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`harness timeout après ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      resolvePromise({ exitCode: code, stdout, stderr, durationMs });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Vérifie qu'aucun secret ou pattern sensible n'apparaît dans la sortie combinée.
 */
function assertNoSecrets(combined: string): void {
  expect(combined).not.toMatch(/postgres:\/\//i);
  expect(combined).not.toMatch(/postgresql:\/\//i);
  expect(combined).not.toMatch(/re_\w/i);
  expect(combined).not.toMatch(/R2_SECRET_ACCESS_KEY/i);
  expect(combined).not.toMatch(/RESEND_API_KEY/i);
}

/**
 * Vérifie l'absence de stack trace dans la sortie combinée.
 */
function assertNoStack(combined: string): void {
  expect(combined).not.toMatch(/\sat\s/);
}

describe('Smoke harness', () => {
  beforeAll(() => {
    // Build frais pour garantir un dist/index.js à jour avant les tests.
    const result = spawnSync('node', [buildScriptPath], {
      cwd: workerRoot,
      stdio: 'pipe',
    });
    if (result.status !== 0) {
      throw new Error(
        `build échoué en beforeAll (exit ${result.status}): ${result.stderr.toString()}`,
      );
    }
  });

  it('harness échoue proprement quand le bundle est absent (exit 2)', async () => {
    const nonexistentBundle = `/tmp/uttily-nonexistent-${Date.now()}.js`;
    const result = await runHarness([`--bundle=${nonexistentBundle}`], 10_000);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/bundle/);
    expect(result.stdout).toBe('');

    const combined = `${result.stdout}\n${result.stderr}`;
    assertNoStack(combined);
    expect(combined).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    assertNoSecrets(combined);
  });

  it('harness termine par timeout (exit 70) quand startWorker ne résout jamais', async () => {
    const result = await runHarness([`--bundle=${hangingFixturePath}`, '--timeout-ms=100'], 5_000);

    expect(result.exitCode).toBe(70);
    expect(result.stderr).toMatch(/timeout/i);
    expect(result.stdout).toBe('');

    const combined = `${result.stdout}\n${result.stderr}`;
    assertNoStack(combined);
    expect(result.durationMs).toBeLessThan(3_000);
    expect(result.durationMs).toBeGreaterThanOrEqual(50);
    assertNoSecrets(combined);
  });

  it('harness réussit naturellement (exit 0) avec stdout exact et stderr vide', async () => {
    const result = await runHarness([], 15_000);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('Worker smoke: OK (bundle loaded, start/shutdown verified)');
    expect(result.stderr).toBe('');
    expect(result.durationMs).toBeLessThan(10_000);

    const combined = `${result.stdout}\n${result.stderr}`;
    assertNoSecrets(combined);
  });

  it('console synchrone pendant l import détectée (exit 1)', async () => {
    const result = await runHarness(
      [`--bundle=${syncConsoleFixturePath}`, '--timeout-ms=100'],
      5_000,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/assertion/);
    expect(result.durationMs).toBeLessThan(3_000);

    const combined = `${result.stdout}\n${result.stderr}`;
    assertNoStack(combined);
    assertNoSecrets(combined);
  });

  it('console différée au setImmediate détectée (exit 1, pas exit 70)', async () => {
    const result = await runHarness(
      [`--bundle=${deferredConsoleFixturePath}`, '--timeout-ms=100'],
      5_000,
    );

    // L'assertion consoleCallCount === 0 doit échouer AVANT le timeout (exit 1,
    // pas exit 70). C'est la preuve clé que la capture différée fonctionne.
    expect(result.exitCode).toBe(1);
    expect(result.exitCode).not.toBe(70);
    expect(result.stderr).toMatch(/assertion/);
    expect(result.durationMs).toBeLessThan(3_000);

    const combined = `${result.stdout}\n${result.stderr}`;
    assertNoStack(combined);
    assertNoSecrets(combined);
  });

  describe('validation stricte de --timeout-ms (exit 64, échec immédiat)', () => {
    const invalidValues = ['49', '10001', '100junk', '100.5', ''];

    // Helper pour les cas de timeout invalide — évite d'attendre 5s.
    async function runInvalidTimeout(value: string): Promise<HarnessResult> {
      return runHarness([`--timeout-ms=${value}`], 3_000);
    }

    it.each(invalidValues)(
      'timeout invalide %j → exit 64, échec immédiat, sans interpolation',
      async (value) => {
        const result = await runInvalidTimeout(value);

        expect(result.exitCode).toBe(64);
        expect(result.stderr).toContain('timeout invalide');
        expect(result.stdout).toBe('');
        // Aucune interpolation de la valeur reçue dans stderr (sauf chaîne vide
        // qui est trivialement contenue par toute chaîne).
        if (value !== '') {
          expect(result.stderr).not.toContain(value);
        }
        // L'échec est immédiat — aucune attente de 5s.
        expect(result.durationMs).toBeLessThan(1_000);

        const combined = `${result.stdout}\n${result.stderr}`;
        assertNoStack(combined);
        assertNoSecrets(combined);
      },
    );
  });

  it('fixtures absentes de dist — seuls index.js et index.js.map', () => {
    // beforeAll a déjà exécuté un build frais ; on vérifie le contenu de dist.
    const entries = readdirSync(distDir).sort();
    expect(entries).toEqual(['index.js', 'index.js.map']);
    // Aucun nom de fixture ne doit apparaître dans dist.
    for (const entry of entries) {
      expect(entry).not.toMatch(/fixture/i);
      expect(entry).not.toMatch(/hanging/i);
      expect(entry).not.toMatch(/deferred/i);
      expect(entry).not.toMatch(/sync-console/i);
    }
  });
});
