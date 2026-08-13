import { describe, expect, it } from 'vitest';
import { executeRefundRequestBatch } from './execute-refund-request-batch';
import { RefundRequestError } from './errors';
import { getBackoffIntervalSeconds, validateBatchLimit } from './scheduling';
import type { DatabaseClient } from '@uttily/database';
import type { PaymentProviderAdapter } from '../payments/types';

describe('refund-request-execution — contrat de planification', () => {
  it.each([1, 5, 10])('accepte batchLimit=%s', (batchLimit) => {
    expect(validateBatchLimit(batchLimit)).toBe(batchLimit);
  });

  it.each([0, -1, 1.5, 11, Number.NaN])('rejette batchLimit=%s', (batchLimit) => {
    expect(() => validateBatchLimit(batchLimit)).toThrow();
  });

  it('applique le batch par défaut', () => {
    expect(validateBatchLimit(undefined)).toBe(10);
  });

  it('calcule le backoff exponentiel déterministe', () => {
    expect([0, 1, 2, 3, 4].map(getBackoffIntervalSeconds)).toEqual([30, 60, 120, 240, 480]);
  });

  it('refuse un provider TEST pour un batch LIVE avant tout accès DB', async () => {
    const provider = { environment: 'TEST' } as PaymentProviderAdapter;
    await expect(
      executeRefundRequestBatch(
        { db: {} as DatabaseClient, provider },
        { environment: 'LIVE', batchLimit: 1 },
      ),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_MISMATCH' });
  });

  it('expose des erreurs worker typées et fermées', () => {
    const error = new RefundRequestError('PAYLOAD_MALFORMED', 'payload invalide');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('PAYLOAD_MALFORMED');
    expect(error.message).toContain('PAYLOAD_MALFORMED');
  });
});
