import { describe, expect, it } from 'vitest';
import {
  RESEND_IDEMPOTENCY_WINDOW_MS,
  isProviderIdempotencyWindowExpired,
} from './provider-idempotency-window';
import { validateManualNotificationRetry } from './manual-retry-policy';

const NOW = new Date('2026-08-28T12:00:00.000Z');

describe('provider-idempotency-window (source unique partagée)', () => {
  it('expose une fenêtre de 24 heures', () => {
    expect(RESEND_IDEMPOTENCY_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('considère la fenêtre comme expirée strictement au-delà de 24 h', () => {
    const first = new Date(NOW.getTime() - RESEND_IDEMPOTENCY_WINDOW_MS);
    // À la limite exacte (24 h), le moteur considère encore la fenêtre sûre.
    expect(isProviderIdempotencyWindowExpired(first, NOW)).toBe(false);
    expect(isProviderIdempotencyWindowExpired(new Date(first.getTime() - 1), NOW)).toBe(true);
  });

  it('est fail-closed si l’horodatage est absent ou invalide', () => {
    expect(isProviderIdempotencyWindowExpired(null, NOW)).toBe(true);
    expect(isProviderIdempotencyWindowExpired(undefined, NOW)).toBe(true);
    expect(isProviderIdempotencyWindowExpired(new Date('not-a-date'), NOW)).toBe(true);
  });
});

describe('validateManualNotificationRetry (politique fermée V1)', () => {
  it('autorise la relance MAX_RETRIES_EXCEEDED encore dans la fenêtre d’idempotence provider (motif obligatoire côté use case)', () => {
    const res = validateManualNotificationRetry(
      {
        status: 'FAILED',
        failureCode: 'MAX_RETRIES_EXCEEDED',
        requiresManualReview: true,
        attemptCount: 5,
        providerFirstAttemptStartedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000), // 2 h < 24 h
      },
      NOW,
    );
    expect(res.allowed).toBe(true);
  });

  it('refuse fail-closed MAX_RETRIES_EXCEEDED si la fenêtre d’idempotence provider est dépassée', () => {
    const res = validateManualNotificationRetry(
      {
        status: 'FAILED',
        failureCode: 'MAX_RETRIES_EXCEEDED',
        requiresManualReview: true,
        attemptCount: 5,
        providerFirstAttemptStartedAt: new Date(NOW.getTime() - RESEND_IDEMPOTENCY_WINDOW_MS - 1),
      },
      NOW,
    );
    expect(res.allowed).toBe(false);
    if (!res.allowed) {
      expect(res.code).toBe('MAX_RETRIES_IDEMPOTENCY_WINDOW_EXPIRED');
    }
  });

  it('refuse fail-closed MAX_RETRIES_EXCEEDED si providerFirstAttemptStartedAt est indéterminable', () => {
    // Absence totale de la propriété : indéterminable => fail-closed.
    const withoutTimestamp = validateManualNotificationRetry(
      {
        status: 'FAILED',
        failureCode: 'MAX_RETRIES_EXCEEDED',
        requiresManualReview: true,
        attemptCount: 5,
      },
      NOW,
    );
    expect(withoutTimestamp.allowed).toBe(false);
    if (!withoutTimestamp.allowed) {
      expect(withoutTimestamp.code).toBe('MAX_RETRIES_WINDOW_UNDETERMINABLE');
    }

    const res = validateManualNotificationRetry(
      {
        status: 'FAILED',
        failureCode: 'MAX_RETRIES_EXCEEDED',
        requiresManualReview: true,
        attemptCount: 5,
        providerFirstAttemptStartedAt: null,
      },
      NOW,
    );
    expect(res.allowed).toBe(false);
    if (!res.allowed) {
      expect(res.code).toBe('MAX_RETRIES_WINDOW_UNDETERMINABLE');
    }
  });

  it('refuse la relance pour INVALID_REQUEST / erreur déterministe provider (répéter ne corrige pas la cause)', () => {
    const res = validateManualNotificationRetry(
      {
        status: 'FAILED',
        failureCode: 'INVALID_REQUEST',
        requiresManualReview: true,
        attemptCount: 1,
      },
      NOW,
    );
    expect(res.allowed).toBe(false);
    if (!res.allowed) {
      expect(res.code).toBe('DETERMINISTIC_FAILURE_NO_RETRY');
    }
  });

  it('refuse catégoriquement la relance pour PROVIDER_RESULT_UNCERTAIN_WINDOW_EXPIRED (anti-doublon)', () => {
    const res = validateManualNotificationRetry(
      {
        status: 'FAILED',
        failureCode: 'PROVIDER_RESULT_UNCERTAIN_WINDOW_EXPIRED',
        requiresManualReview: true,
        attemptCount: 2,
        providerFirstAttemptStartedAt: new Date(NOW.getTime() - 60 * 1000),
      },
      NOW,
    );
    expect(res.allowed).toBe(false);
    if (!res.allowed) {
      expect(res.code).toBe('UNCERTAIN_WINDOW_EXPIRED_NO_RETRY');
    }
  });

  it('refuse fail-closed tout code FAILED inconnu, legacy ou brut (allowlist fermée, pas une denylist)', () => {
    for (const failureCode of [
      'PROVIDER_RATE_LIMIT',
      'RATE_LIMITED',
      'PROVIDER_5XX',
      'NETWORK_UNREACHABLE',
      'PROVIDER_TIMEOUT',
      'NETWORK_TIMEOUT_UNCERTAIN',
      'UNKNOWN_ERROR',
      'FAKE_ERROR',
      'Erreur réseau imprévue: ECONNRESET (message brut)',
    ]) {
      const res = validateManualNotificationRetry(
        {
          status: 'FAILED',
          failureCode,
          requiresManualReview: false,
          attemptCount: 3,
          providerFirstAttemptStartedAt: new Date(NOW.getTime() - 60 * 1000),
        },
        NOW,
      );
      expect(res.allowed, `failureCode=${failureCode} doit être refusé`).toBe(false);
      if (!res.allowed) {
        expect(res.code, `failureCode=${failureCode}`).toBe('FAILURE_CODE_FAIL_CLOSED');
      }
    }
  });

  it('refuse fail-closed une notification FAILED sans code d’échec exploitable', () => {
    // Absence totale de la propriété, null et blanc : tous fail-closed.
    expect(validateManualNotificationRetry({ status: 'FAILED' }, NOW).allowed).toBe(false);
    for (const failureCode of [null, '   ']) {
      const res = validateManualNotificationRetry({ status: 'FAILED', failureCode }, NOW);
      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.code).toBe('FAILURE_CODE_FAIL_CLOSED');
      }
    }
  });

  it('refuse la relance pour les statuts non-FAILED (SENT, PENDING, SENDING, CANCELLED)', () => {
    for (const status of ['SENT', 'PENDING', 'SENDING', 'CANCELLED']) {
      const res = validateManualNotificationRetry(
        {
          status,
          failureCode: 'MAX_RETRIES_EXCEEDED',
          requiresManualReview: false,
          attemptCount: 0,
        },
        NOW,
      );
      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.code).toBe('INVALID_STATUS');
      }
    }
  });
});
