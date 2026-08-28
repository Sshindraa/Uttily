import { describe, expect, it } from 'vitest';
import {
  getMobileApiRetryRule,
  isMobileApiErrorCode,
  MOBILE_API_ERROR_CODES,
  MOBILE_API_ERROR_RETRY,
  MOBILE_RETRY_POLICIES,
} from './mobile-api';

describe('mobile API contract', () => {
  it('expose une union d erreurs fermée et indépendante du Web', () => {
    expect(MOBILE_API_ERROR_CODES).toEqual([
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'VALIDATION_ERROR',
      'CONFLICT',
      'IDEMPOTENCY_CONFLICT',
      'HOLD_EXPIRED',
      'INSUFFICIENT_AVAILABILITY',
      'PAYMENT_ACTION_REQUIRED',
      'PAYMENT_PENDING',
      'RATE_LIMITED',
      'INTERNAL_ERROR',
    ]);
    expect(MOBILE_RETRY_POLICIES).toEqual([
      'RETRY_SAFE',
      'RETRY_WITH_SAME_IDEMPOTENCY_KEY',
      'DO_NOT_RETRY',
      'REFRESH_STATE_BEFORE_RETRY',
    ]);
    expect(isMobileApiErrorCode('INTERNAL_ERROR')).toBe(true);
    expect(isMobileApiErrorCode('UNKNOWN_SQL_ERROR')).toBe(false);
  });

  it('fournit une règle de reprise pour chaque code', () => {
    for (const code of MOBILE_API_ERROR_CODES) {
      expect(getMobileApiRetryRule(code)).toEqual(MOBILE_API_ERROR_RETRY[code]);
    }
    expect(getMobileApiRetryRule('RATE_LIMITED')).toEqual({
      retryable: true,
      policy: 'RETRY_SAFE',
    });
    expect(getMobileApiRetryRule('IDEMPOTENCY_CONFLICT')).toEqual({
      retryable: false,
      policy: 'DO_NOT_RETRY',
    });
  });
});
