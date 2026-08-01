import { describe, it, expect } from 'vitest';
import { validateBatchLimit, MAX_BATCH_LIMIT } from './scheduling';
import { ReconciliationError } from './errors';

describe('validateBatchLimit', () => {
  it('accepte 1', () => {
    expect(validateBatchLimit(1)).toBe(1);
  });

  it('accepte 10 (MAX_BATCH_LIMIT)', () => {
    expect(validateBatchLimit(MAX_BATCH_LIMIT)).toBe(MAX_BATCH_LIMIT);
  });

  it('rejette 0', () => {
    expect(() => validateBatchLimit(0)).toThrow(ReconciliationError);
    expect(() => validateBatchLimit(0)).toThrow('BATCH_LIMIT_INVALID');
  });

  it('rejette 11 (au-dessus du max)', () => {
    expect(() => validateBatchLimit(11)).toThrow(ReconciliationError);
    expect(() => validateBatchLimit(11)).toThrow('BATCH_LIMIT_INVALID');
  });

  it('rejette -1 (négatif)', () => {
    expect(() => validateBatchLimit(-1)).toThrow(ReconciliationError);
    expect(() => validateBatchLimit(-1)).toThrow('BATCH_LIMIT_INVALID');
  });

  it('rejette 1.5 (non-entier)', () => {
    expect(() => validateBatchLimit(1.5)).toThrow(ReconciliationError);
    expect(() => validateBatchLimit(1.5)).toThrow('BATCH_LIMIT_INVALID');
  });

  it('rejette NaN', () => {
    expect(() => validateBatchLimit(NaN)).toThrow(ReconciliationError);
    expect(() => validateBatchLimit(NaN)).toThrow('BATCH_LIMIT_INVALID');
  });
});
