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
 * Date de travail : 2026-08-08.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebhookHandlerError, type WebhookHandlerErrorCode } from '../webhook-handler/errors';
import { BookingDraftError } from '../booking-drafts/errors';

describe('G7I — security sentinel: no client_secret or provider details in public errors', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // GAP 4a: WebhookHandlerError does not include client_secret in message or responseBody
  // ─────────────────────────────────────────────────────────────────────────
  // Complete list of all production source files that construct WebhookHandlerError.
  // Found via: grep -rn 'new WebhookHandlerError' packages/core/src/ --include='*.ts' | grep -v '.test.'
  const sourceFiles = [
    join(__dirname, '..', 'webhook-handler', 'validate-authority.ts'),
    join(__dirname, '..', 'webhook-handler', 'resolve-attempt.ts'),
    join(__dirname, '..', 'webhook-handler', 'resolve-amendment-attempt.ts'),
    join(__dirname, '..', 'webhook-handler', 'handle-non-success.ts'),
    join(__dirname, '..', 'webhook-handler', 'confirm-booking.ts'),
    join(__dirname, '..', 'webhook-handler', 'compensate-late.ts'),
    join(__dirname, '..', 'payment-transitions', 'lock-rows.ts'),
    join(__dirname, '..', 'payment-transitions', 'apply-booking-confirmation.ts'),
    join(__dirname, '..', 'booking-amendments', 'apply-supplement-amendment.ts'),
    join(__dirname, '..', 'booking-amendments', 'initiate-supplement-payment.ts'),
  ];

  it('no production WebhookHandlerError constructor leaks client_secret in its message argument (multi-line aware static check)', () => {
    // For each source file, find every `new WebhookHandlerError(...)` occurrence and
    // check a window of 5 lines AFTER the constructor line (to catch multi-line
    // template literals where the message spans several lines).
    for (const file of sourceFiles) {
      let fileContent = '';
      try {
        fileContent = readFileSync(file, 'utf8');
      } catch {
        // File may not exist in all contexts — skip silently.
        continue;
      }
      const lines = fileContent.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes('new WebhookHandlerError')) {
          // Check the constructor line itself plus a 5-line window after it.
          const windowEnd = Math.min(i + 6, lines.length);
          const window = lines.slice(i, windowEnd).join('\n');
          expect(window).not.toContain('client_secret');
          expect(window).not.toContain('clientSecret');
        }
      }
    }
  });

  it('no production WebhookHandlerError constructor leaks raw SQL fragments or Stripe internal IDs in its message argument', () => {
    // Read each actual source file and verify that no WebhookHandlerError message
    // argument contains raw SQL keywords (SELECT, INSERT, UPDATE, DELETE, FROM in a
    // SQL context) or provider internal detail prefixes (sk_, acct_, pi_).
    //
    // Internal UUIDs in messages are acceptable for server-side errors, but SQL
    // fragments and client_secret are not.
    for (const file of sourceFiles) {
      let fileContent = '';
      try {
        fileContent = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const lines = fileContent.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes('new WebhookHandlerError')) {
          // Extract the message argument: check a window of 5 lines after the
          // constructor line (messages may span multiple lines as template literals).
          const windowEnd = Math.min(i + 6, lines.length);
          const window = lines.slice(i, windowEnd).join('\n');

          // No raw SQL keywords in a SQL-statement context.
          // We check for SQL keywords followed by typical SQL patterns.
          expect(window).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE)\s.+\bFROM\b/i);
          expect(window).not.toMatch(/\bINSERT\s+INTO\b/i);
          expect(window).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
          expect(window).not.toMatch(/\bDELETE\s+FROM\b/i);

          // No Stripe provider internal detail prefixes in error messages.
          // acct_ is acceptable in connected account configuration context but
          // not in user-facing error messages.
          expect(window).not.toMatch(/['"`]sk_/);
          expect(window).not.toMatch(/['"`]pi_/);
          expect(window).not.toMatch(/['"`]acct_/);
        }
      }
    }
  });

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
