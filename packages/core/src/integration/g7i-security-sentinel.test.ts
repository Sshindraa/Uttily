/**
 * @uttily/core — G7I Lot 7 security sentinel tests.
 *
 * Tests sentinelles garantissant qu'aucun secret (client_secret, données de
 * carte) ni détail SQL/provider n'apparaît dans les erreurs fermées exposées
 * publiquement (WebhookHandlerError, BookingDraftError).
 *
 * Ces tests sont des tests unitaires purs (pas de PostgreSQL) — ils vérifient
 * les constructeurs d'erreurs et les codes fermés via analyse statique du
 * code source et construction d'instances.
 *
 * Fail-closed : la découverte des fichiers est récursive (aucune liste codée en
 * dur). Si un fichier découvert ne peut être lu, le test échoue. Au moins un
 * call site WebhookHandlerError et un call site BookingDraftError doivent être
 * trouvés, sinon le test échoue.
 *
 * Date de travail : 2026-08-15.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { WebhookHandlerError, type WebhookHandlerErrorCode } from '../webhook-handler/errors';
import { BookingDraftError } from '../booking-drafts/errors';

// ─────────────────────────────────────────────────────────────────────────────
// Recursive discovery of all production .ts files under packages/core/src/
// Excludes .test.ts, .fixture.ts, and directories named __fixtures__ or __generated__
// ─────────────────────────────────────────────────────────────────────────────

const SRC_ROOT = join(__dirname, '..');

function isExcludedFile(fileName: string): boolean {
  return fileName.endsWith('.test.ts') || fileName.endsWith('.fixture.ts');
}

function isExcludedDir(dirName: string): boolean {
  return dirName === '__fixtures__' || dirName === '__generated__';
}

function discoverTsFiles(dir: string, acc: string[] = []): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isExcludedDir(entry.name)) continue;
      discoverTsFiles(fullPath, acc);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !isExcludedFile(entry.name)) {
      acc.push(fullPath);
    }
  }
  return acc;
}

const discoveredFiles = discoverTsFiles(SRC_ROOT);

// ─────────────────────────────────────────────────────────────────────────────
// Helper: check a 6-line window (constructor line + 5 following lines) for leaks
// ─────────────────────────────────────────────────────────────────────────────

interface LeakFinding {
  filePath: string;
  lineNumber: number;
  pattern: string;
}

function findLeaksInFile(
  filePath: string,
  constructorName: 'WebhookHandlerError' | 'BookingDraftError',
): LeakFinding[] {
  const content = readFileSync(filePath, 'utf8'); // fail-closed: no try/catch
  const lines = content.split('\n');
  const findings: LeakFinding[] = [];
  const needle = `new ${constructorName}(`;

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.includes(needle)) continue;
    const windowEnd = Math.min(i + 6, lines.length);
    const window = lines.slice(i, windowEnd).join('\n');

    // client_secret or clientSecret (case-insensitive)
    if (/client_secret|clientsecret/i.test(window)) {
      findings.push({ filePath, lineNumber: i + 1, pattern: 'client_secret/clientSecret' });
    }

    // Raw SQL patterns
    if (/\b(SELECT|INSERT|UPDATE|DELETE)\s.+\bFROM\b/i.test(window)) {
      findings.push({
        filePath,
        lineNumber: i + 1,
        pattern: 'SQL SELECT/INSERT/UPDATE/DELETE ... FROM',
      });
    }
    if (/\bINSERT\s+INTO\b/i.test(window)) {
      findings.push({ filePath, lineNumber: i + 1, pattern: 'SQL INSERT INTO' });
    }
    if (/\bUPDATE\s+\w+\s+SET\b/i.test(window)) {
      findings.push({ filePath, lineNumber: i + 1, pattern: 'SQL UPDATE ... SET' });
    }
    if (/\bDELETE\s+FROM\b/i.test(window)) {
      findings.push({ filePath, lineNumber: i + 1, pattern: 'SQL DELETE FROM' });
    }

    // Stripe provider prefixes in quoted strings
    if (/['"`]sk_/.test(window)) {
      findings.push({ filePath, lineNumber: i + 1, pattern: 'Stripe sk_ prefix' });
    }
    if (/['"`]pi_/.test(window)) {
      findings.push({ filePath, lineNumber: i + 1, pattern: 'Stripe pi_ prefix' });
    }
    if (/['"`]acct_/.test(window)) {
      findings.push({ filePath, lineNumber: i + 1, pattern: 'Stripe acct_ prefix' });
    }
  }
  return findings;
}

describe('G7I — security sentinel: no client_secret or provider details in public errors', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Verify at least one real constructor call site is found for each error type
  // ─────────────────────────────────────────────────────────────────────────
  it('discovers at least one real WebhookHandlerError constructor call site in production source', () => {
    let webhookCount = 0;
    for (const file of discoveredFiles) {
      const content = readFileSync(file, 'utf8');
      if (content.includes('new WebhookHandlerError(')) {
        webhookCount++;
      }
    }
    expect(webhookCount).toBeGreaterThanOrEqual(1);
  });

  it('discovers at least one real BookingDraftError constructor call site in production source', () => {
    let bookingDraftCount = 0;
    for (const file of discoveredFiles) {
      const content = readFileSync(file, 'utf8');
      if (content.includes('new BookingDraftError(')) {
        bookingDraftCount++;
      }
    }
    expect(bookingDraftCount).toBeGreaterThanOrEqual(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GAP 4a: WebhookHandlerError — coverage gap detection (fail-closed)
  // ─────────────────────────────────────────────────────────────────────────
  it('no production WebhookHandlerError constructor leaks client_secret, raw SQL, or Stripe provider prefixes (recursive fail-closed static analysis)', () => {
    const allFindings: LeakFinding[] = [];
    for (const file of discoveredFiles) {
      const content = readFileSync(file, 'utf8');
      if (!content.includes('new WebhookHandlerError(')) continue;
      const findings = findLeaksInFile(file, 'WebhookHandlerError');
      allFindings.push(...findings);
    }
    if (allFindings.length > 0) {
      const details = allFindings
        .map((f) => `  - ${relative(SRC_ROOT, f.filePath)}:${f.lineNumber} — ${f.pattern}`)
        .join('\n');
      expect.fail(
        `WebhookHandlerError leak detected in ${allFindings.length} call site(s):\n${details}`,
      );
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GAP 4b: BookingDraftError — coverage gap detection (fail-closed)
  // ─────────────────────────────────────────────────────────────────────────
  it('no production BookingDraftError constructor leaks client_secret, raw SQL, or Stripe provider prefixes (recursive fail-closed static analysis)', () => {
    const allFindings: LeakFinding[] = [];
    for (const file of discoveredFiles) {
      const content = readFileSync(file, 'utf8');
      if (!content.includes('new BookingDraftError(')) continue;
      const findings = findLeaksInFile(file, 'BookingDraftError');
      allFindings.push(...findings);
    }
    if (allFindings.length > 0) {
      const details = allFindings
        .map((f) => `  - ${relative(SRC_ROOT, f.filePath)}:${f.lineNumber} — ${f.pattern}`)
        .join('\n');
      expect.fail(
        `BookingDraftError leak detected in ${allFindings.length} call site(s):\n${details}`,
      );
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Synthetic assertions: construct error instances and verify responseBody
  // ─────────────────────────────────────────────────────────────────────────
  it('WebhookHandlerError responseBody and message do not leak provider details (raw SQL, Stripe internal IDs beyond connected account)', () => {
    // Construct a WebhookHandlerError with a typical message and verify responseBody.
    const err = new WebhookHandlerError('WEBHOOK_ATTEMPT_NOT_FOUND', 'Tentative introuvable.');
    expect(err.responseBody.error).toBe('NOT_FOUND');
    expect(err.responseBody.message).toBe('Tentative introuvable.');
    // No raw SQL fragments
    expect(err.responseBody.message).not.toMatch(/SELECT|INSERT|UPDATE|DELETE|FROM\s+\w+/i);
    expect(err.responseBody.error).not.toMatch(/SELECT|INSERT|UPDATE|DELETE/i);
    // No Stripe provider detail keywords
    expect(err.responseBody.message).not.toContain('stripe');
    expect(err.responseBody.message).not.toContain('pi_');
    expect(err.responseBody.message).not.toContain('ch_');
    expect(err.responseBody.message).not.toContain('acct_');
  });

  it('WebhookHandlerError closed error codes (CONFLICT_BLOCK equivalent, NOT_FOUND) do not contain raw SQL or provider details', () => {
    // WebhookHandlerError uses closed codes like WEBHOOK_ATTEMPT_NOT_FOUND → NOT_FOUND.
    // There is no CONFLICT_BLOCK in webhook-handler, but the equivalent closed codes
    // (WEBHOOK_ORGANIZATION_MISMATCH → FORBIDDEN) must also not leak details.
    const notFoundErr = new WebhookHandlerError(
      'WEBHOOK_ATTEMPT_NOT_FOUND',
      'Aucune tentative de paiement correspondante.',
    );
    expect(notFoundErr.responseBody.error).toBe('NOT_FOUND');
    expect(notFoundErr.responseBody.message).not.toMatch(/SELECT|INSERT|UPDATE|DELETE/i);
    expect(notFoundErr.responseBody.message).not.toContain('stripe');
    expect(notFoundErr.responseBody.message).not.toContain('client_secret');

    const forbiddenErr = new WebhookHandlerError(
      'WEBHOOK_ORGANIZATION_MISMATCH',
      "L'organisation ne correspond pas.",
    );
    expect(forbiddenErr.responseBody.error).toBe('FORBIDDEN');
    expect(forbiddenErr.responseBody.message).not.toMatch(/SELECT|INSERT|UPDATE|DELETE/i);
    expect(forbiddenErr.responseBody.message).not.toContain('stripe');
    expect(forbiddenErr.responseBody.message).not.toContain('client_secret');
  });

  it('BookingDraftError closed error codes (CONFLICT_BLOCK, NOT_FOUND) do not contain raw SQL or provider details', () => {
    // BookingDraftError is the error used by createBookingDraftWithHold.
    // CONFLICT_BLOCK and NOT_FOUND are the closed public error codes.
    const conflictErr = new BookingDraftError(
      'CONFLICT_BLOCK',
      'Le créneau est déjà réservé par un autre client.',
    );
    expect(conflictErr.code).toBe('CONFLICT_BLOCK');
    expect(conflictErr.responseBody.error).toBe('CONFLICT_BLOCK');
    expect(conflictErr.responseBody.message).not.toMatch(/SELECT|INSERT|UPDATE|DELETE/i);
    expect(conflictErr.responseBody.message).not.toContain('stripe');
    expect(conflictErr.responseBody.message).not.toContain('client_secret');
    expect(conflictErr.responseBody.message).not.toContain('pi_');
    expect(conflictErr.responseBody.message).not.toContain('acct_');

    const notFoundErr = new BookingDraftError('NOT_FOUND', 'Organisation introuvable.');
    expect(notFoundErr.code).toBe('NOT_FOUND');
    expect(notFoundErr.responseBody.error).toBe('NOT_FOUND');
    expect(notFoundErr.responseBody.message).not.toMatch(/SELECT|INSERT|UPDATE|DELETE/i);
    expect(notFoundErr.responseBody.message).not.toContain('stripe');
    expect(notFoundErr.responseBody.message).not.toContain('client_secret');
  });

  it('all WebhookHandlerErrorCode values are closed and do not include provider-specific detail codes', () => {
    // The closed set of error codes must not expose provider internals.
    const closedCodes: WebhookHandlerErrorCode[] = [
      'WEBHOOK_SIGNATURE_INVALID',
      'WEBHOOK_TIMESTAMP_INVALID',
      'WEBHOOK_PAYLOAD_INVALID',
      'WEBHOOK_EVENT_TYPE_UNHANDLED',
      'WEBHOOK_ATTEMPT_NOT_FOUND',
      'WEBHOOK_AMOUNT_MISMATCH',
      'WEBHOOK_CURRENCY_MISMATCH',
      'WEBHOOK_ENVIRONMENT_MISMATCH',
      'WEBHOOK_DESTINATION_MISMATCH',
      'WEBHOOK_ORGANIZATION_MISMATCH',
      'WEBHOOK_DRAFT_NOT_PROCESSING',
      'WEBHOOK_ALREADY_PROCESSED',
      'WEBHOOK_LATE_PAYMENT',
      'WEBHOOK_INVARIANT_BROKEN',
      'WEBHOOK_AGGREGATE_INCONSISTENT',
      'UNKNOWN',
    ];
    for (const code of closedCodes) {
      // No code should reference client_secret, card data, or raw SQL.
      expect(code).not.toMatch(/client_secret|card|sql|stripe|pi_|ch_/i);
    }
  });
});
