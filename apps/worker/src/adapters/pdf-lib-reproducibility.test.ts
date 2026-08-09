/**
 * @uttily/worker — Reproductibilité cross-process / cross-TZ / source-vs-dist (G5H-C2C-B2).
 *
 * Prouve que le rendu PDF est reproductible :
 * 1. Cross-process : deux processus Node séparés produisent les mêmes bytes/checksum.
 * 2. TZ independence : rendu identique sous différents fuseaux horaires.
 * 3. Source vs dist : le rendu depuis le source (tsx) et depuis le dist (node) sont identiques.
 * 4. Build from different cwd : `pnpm --filter @uttily/worker build` et `node build.mjs` produisent un dist fonctionnel.
 * 5. No missing runtime deps : `node dist/index.js` échoue avec WorkerConfigurationError (pas ERR_MODULE_NOT_FOUND).
 *
 * Ces tests sont lents (spawning de processus). Utiliser SKIP_REPRODUCIBILITY=1 pour les skipper.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DocumentRenderSnapshotV1 } from '@uttily/core';

import { PdfLibDocumentRenderer } from './pdf-lib-document-renderer';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(__dirname, '../../../..');
const WORKER_DIR = resolve(REPO_ROOT, 'apps/worker');
const DIST_INDEX = resolve(WORKER_DIR, 'dist/index.js');
const TIMEOUT_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot helper (dupliqué depuis pdf-lib-document-renderer.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [P in keyof T]: DeepMutable<T[P]> }
    : T;

type MutableSnapshot = DeepMutable<DocumentRenderSnapshotV1>;

const UUID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const UUID_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const UUID_D = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const UUID_E = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const UUID_F = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

function makeValidSnapshot(): MutableSnapshot {
  return {
    snapshotVersion: 'v1',
    sourceOutboxEventId: UUID_A,
    organizationId: UUID_B,
    bookingId: UUID_C,
    paymentId: UUID_D,
    draftId: UUID_E,
    capturedAt: '2026-01-15T10:00:00.000Z',
    organization: {
      id: UUID_B,
      legalName: 'Alpes Location SARL',
    },
    location: {
      id: UUID_A,
      name: 'Annecy',
      addressLine1: '1 rue du Lac',
      addressLine2: null,
      city: 'Annecy',
      postalCode: '74000',
      countryCode: 'FR',
      timeZone: 'Europe/Paris',
    },
    customer: {
      userId: UUID_F,
      displayName: 'Jean Dupont',
      locale: 'fr',
    },
    booking: {
      id: UUID_C,
      status: 'CONFIRMED',
      customerStartAt: '2026-02-10T09:00:00.000Z',
      customerEndAt: '2026-02-12T17:00:00.000Z',
      confirmedAt: '2026-01-15T10:00:00.000Z',
      prepBufferMinutes: 30,
      cleanupBufferMinutes: 30,
      currency: 'EUR',
      subtotalAmountMinor: 15000,
      mandatoryFeesAmountMinor: 0,
      totalAmountMinor: 15000,
      taxStatus: 'NOT_APPLICABLE',
      taxAmountMinor: 0,
      taxRateBps: null,
      cancellationPolicySnapshot: { policy_code: 'FLEXIBLE' },
      termsAcceptanceSnapshot: { version: 'v1' },
    },
    payment: {
      id: UUID_D,
      status: 'SUCCEEDED',
      succeededAt: '2026-01-15T09:58:00.000Z',
      amountMinor: 15000,
      currency: 'EUR',
      financialTermsVersion: 'v1',
      legalTermsVersion: 'v1',
    },
    lines: [
      {
        lineId: UUID_A,
        variantId: UUID_B,
        quantity: 2,
        unitPriceAmountMinor: 7500,
        billableUnitCount: 2,
        lineTotalAmountMinor: 15000,
        currency: 'EUR',
        variantSnapshot: { name: 'Kayak biplace' },
      },
    ],
    items: [
      {
        bookingItemId: UUID_A,
        bookingLineId: UUID_A,
        inventoryItemId: UUID_A,
        internalSku: 'KAY-001',
        serialNumber: 'SN-001',
        condition: 'GOOD',
        inventoryStatus: 'ACTIVE',
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers pour exécuter des processus externes
// ─────────────────────────────────────────────────────────────────────────────

interface RenderResult {
  checksum: string;
  size: number;
}

/**
 * Écrit un script temporaire qui importe le renderer depuis le source (via tsx),
 * rend un snapshot, et affiche le checksum + size en JSON sur stdout.
 */
function runFromSource(
  templateKey: string,
  snapshot: DocumentRenderSnapshotV1,
  env?: Record<string, string>,
): RenderResult {
  const rendererPath = resolve(WORKER_DIR, 'src/adapters/pdf-lib-document-renderer.ts');
  const scriptContent = `
import { PdfLibDocumentRenderer } from '${rendererPath}';

const snapshot = ${JSON.stringify(snapshot)};
const renderer = new PdfLibDocumentRenderer();
const r = await renderer.render(${JSON.stringify(templateKey)}, snapshot);
const result = JSON.stringify({ checksum: r.checksumSha256, size: r.sizeBytes });
process.stdout.write(result);
`;
  const tmpFile = join(
    tmpdir(),
    `repro-source-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
  );
  writeFileSync(tmpFile, scriptContent);
  try {
    const stdout = execFileSync('npx', ['tsx', tmpFile], {
      cwd: REPO_ROOT,
      timeout: TIMEOUT_MS,
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(stdout) as RenderResult;
  } finally {
    unlinkSync(tmpFile);
  }
}

/**
 * Écrit un script temporaire qui importe le renderer depuis le dist (via node),
 * rend un snapshot, et affiche le checksum + size en JSON sur stdout.
 */
function runFromDist(
  templateKey: string,
  snapshot: DocumentRenderSnapshotV1,
  env?: Record<string, string>,
): RenderResult {
  const distPath = resolve(WORKER_DIR, 'dist/index.js');
  const scriptContent = `
import { PdfLibDocumentRenderer } from '${distPath}';

const snapshot = ${JSON.stringify(snapshot)};
const renderer = new PdfLibDocumentRenderer();
const r = await renderer.render(${JSON.stringify(templateKey)}, snapshot);
const result = JSON.stringify({ checksum: r.checksumSha256, size: r.sizeBytes });
process.stdout.write(result);
`;
  const tmpFile = join(
    tmpdir(),
    `repro-dist-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
  );
  writeFileSync(tmpFile, scriptContent);
  try {
    const stdout = execFileSync('node', [tmpFile], {
      cwd: REPO_ROOT,
      timeout: TIMEOUT_MS,
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(stdout) as RenderResult;
  } finally {
    unlinkSync(tmpFile);
  }
}

/**
 * Exécute une commande et retourne stdout. Lance une erreur avec stderr si le code de sortie est non nul.
 */
function runCommand(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeout?: number } = {},
): string {
  const stdout = execFileSync(command, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    timeout: opts.timeout ?? TIMEOUT_MS,
    encoding: 'utf-8',
    env: { ...process.env, ...opts.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return stdout.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(process.env.SKIP_REPRODUCIBILITY === '1')(
  'PdfLibDocumentRenderer — reproductibilité',
  () => {
    const snapshot = makeValidSnapshot();
    const templateKey = 'booking-confirmation-technical-v1';

    // ── 1. Cross-process reproducibility ──
    it('cross-process : deux processus séparés produisent le même checksum', () => {
      const r1 = runFromSource(templateKey, snapshot);
      const r2 = runFromSource(templateKey, snapshot);

      expect(r1.checksum).toBe(r2.checksum);
      expect(r1.size).toBe(r2.size);
      expect(r1.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(r1.size).toBeGreaterThan(0);
    });

    // ── 2. TZ independence ──
    it('TZ independence : America/New_York et Asia/Tokyo produisent le même checksum', () => {
      const r1 = runFromSource(templateKey, snapshot, { TZ: 'America/New_York' });
      const r2 = runFromSource(templateKey, snapshot, { TZ: 'Asia/Tokyo' });

      expect(r1.checksum).toBe(r2.checksum);
      expect(r1.size).toBe(r2.size);
    });

    it('TZ independence : UTC et Europe/Paris produisent le même checksum', () => {
      const r1 = runFromSource(templateKey, snapshot, { TZ: 'UTC' });
      const r2 = runFromSource(templateKey, snapshot, { TZ: 'Europe/Paris' });

      expect(r1.checksum).toBe(r2.checksum);
    });

    // ── 3. Source vs dist ──
    it('source vs dist : tsx et node dist produisent le même checksum', () => {
      // S'assurer que le dist existe.
      runCommand('pnpm', ['--filter', '@uttily/worker', 'build']);

      const sourceResult = runFromSource(templateKey, snapshot);
      const distResult = runFromDist(templateKey, snapshot);

      expect(sourceResult.checksum).toBe(distResult.checksum);
      expect(sourceResult.size).toBe(distResult.size);
    });

    it('source vs dist : tous les templates produisent le même checksum', () => {
      runCommand('pnpm', ['--filter', '@uttily/worker', 'build']);

      const templates = [
        'booking-confirmation-technical-v1',
        'rental-contract-technical-v1',
        'payment-receipt-technical-v1',
      ];

      for (const tpl of templates) {
        const sourceResult = runFromSource(tpl, snapshot);
        const distResult = runFromDist(tpl, snapshot);
        expect(sourceResult.checksum).toBe(distResult.checksum);
        expect(sourceResult.size).toBe(distResult.size);
      }
    });

    // ── 4. Build from different cwd ──
    it('build from repo root (pnpm --filter) produit un dist fonctionnel', () => {
      runCommand('pnpm', ['--filter', '@uttily/worker', 'build']);

      expect(existsSync(DIST_INDEX)).toBe(true);

      const distResult = runFromDist(templateKey, snapshot);
      const sourceResult = runFromSource(templateKey, snapshot);
      expect(distResult.checksum).toBe(sourceResult.checksum);
    });

    it('build from apps/worker/ (node build.mjs) produit un dist fonctionnel', () => {
      runCommand('node', ['build.mjs'], { cwd: WORKER_DIR });

      expect(existsSync(DIST_INDEX)).toBe(true);

      const distResult = runFromDist(templateKey, snapshot);
      const sourceResult = runFromSource(templateKey, snapshot);
      expect(distResult.checksum).toBe(sourceResult.checksum);
    });

    // ── 5. No missing runtime deps ──
    it('node dist/index.js échoue avec WorkerConfigurationError (pas ERR_MODULE_NOT_FOUND)', () => {
      // S'assurer que le dist existe.
      runCommand('pnpm', ['--filter', '@uttily/worker', 'build']);

      let exitCode: number | null = null;
      let stderr = '';

      try {
        execFileSync('node', [DIST_INDEX], {
          cwd: REPO_ROOT,
          timeout: TIMEOUT_MS,
          encoding: 'utf-8',
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        const err = e as { status?: number; stderr?: string };
        exitCode = err.status ?? null;
        stderr = err.stderr ?? '';
      }

      // Doit s'arrêter avec un code non nul.
      expect(exitCode).not.toBe(0);
      expect(exitCode).not.toBe(null);

      // Doit contenir WorkerConfigurationError (pas ERR_MODULE_NOT_FOUND).
      expect(stderr).toContain('Worker');
      expect(stderr).not.toContain('ERR_MODULE_NOT_FOUND');
      expect(stderr).not.toContain('Cannot find');
    });

    // ── 6. Checksum de référence (in-process) pour validation croisée ──
    it('checksum in-process correspond au checksum cross-process', async () => {
      const renderer = new PdfLibDocumentRenderer();
      const r = await renderer.render(templateKey, snapshot);
      const expectedChecksum = createHash('sha256').update(r.content).digest('hex');

      const crossProcessResult = runFromSource(templateKey, snapshot);

      expect(crossProcessResult.checksum).toBe(r.checksumSha256);
      expect(crossProcessResult.checksum).toBe(expectedChecksum);
    });
  },
);
