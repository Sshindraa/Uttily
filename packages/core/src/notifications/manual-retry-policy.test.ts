import { describe, expect, it } from 'vitest';
import { validateManualNotificationRetry } from './manual-retry-policy';

describe('validateManualNotificationRetry', () => {
  it('autorise la relance pour une notification FAILED avec une erreur retryable standard', () => {
    const res = validateManualNotificationRetry({
      status: 'FAILED',
      failureCode: 'PROVIDER_RATE_LIMIT',
      requiresManualReview: false,
      attemptCount: 3,
    });
    expect(res.allowed).toBe(true);
  });

  it('autorise la relance pour une notification FAILED avec MAX_RETRIES_EXCEEDED si revue par un humain', () => {
    const res = validateManualNotificationRetry({
      status: 'FAILED',
      failureCode: 'MAX_RETRIES_EXCEEDED',
      requiresManualReview: true,
      attemptCount: 5,
    });
    expect(res.allowed).toBe(true);
  });

  it('refuse catégoriquement la relance pour PROVIDER_RESULT_UNCERTAIN_WINDOW_EXPIRED (anti-doublon)', () => {
    const res = validateManualNotificationRetry({
      status: 'FAILED',
      failureCode: 'PROVIDER_RESULT_UNCERTAIN_WINDOW_EXPIRED',
      requiresManualReview: true,
      attemptCount: 2,
    });
    expect(res.allowed).toBe(false);
    if (!res.allowed) {
      expect(res.code).toBe('UNCERTAIN_WINDOW_EXPIRED_NO_RETRY');
    }
  });

  it('refuse la relance pour les statuts non-FAILED (SENT, PENDING, SENDING, CANCELLED)', () => {
    for (const status of ['SENT', 'PENDING', 'SENDING', 'CANCELLED']) {
      const res = validateManualNotificationRetry({
        status,
        failureCode: null,
        requiresManualReview: false,
        attemptCount: 0,
      });
      expect(res.allowed).toBe(false);
      if (!res.allowed) {
        expect(res.code).toBe('INVALID_STATUS');
      }
    }
  });
});
