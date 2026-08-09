/**
 * @uttily/worker — Tests unitaires des failure codes normalisés (G5F).
 */

import { describe, it, expect } from 'vitest';
import { normalizeFailureCode, WORKER_FAILURE_CODES } from './failure-codes';

describe('normalizeFailureCode', () => {
  // Codes publics → eux-mêmes.
  const publicCodes: readonly string[] = WORKER_FAILURE_CODES;

  for (const code of publicCodes) {
    it(`code public ${code} → ${code}`, () => {
      expect(normalizeFailureCode(code)).toBe(code);
    });
  }

  // Codes internes G5C (DocumentRenderErrorCode) → UNKNOWN_ERROR.
  const internalRenderCodes = [
    'VALIDATION',
    'EVENT_NOT_FOUND',
    'EVENT_CONTRACT_MISMATCH',
    'AUTHORITY_MISMATCH',
    'SNAPSHOT_INVARIANT',
    'UNKNOWN',
  ];

  for (const code of internalRenderCodes) {
    it(`code interne G5C ${code} → UNKNOWN_ERROR`, () => {
      expect(normalizeFailureCode(code)).toBe('UNKNOWN_ERROR');
    });
  }

  // Codes internes G5D/G5E (fail-closed, invariants) → UNKNOWN_ERROR.
  const internalPipelineCodes = [
    'EFFECT_SET_INVARIANT_VIOLATED',
    'NOTIFICATION_MISSING',
    'FAIL_CLOSED_INCONSISTENT_STATE',
    'FAIL_CLOSED_LEASE_LOST',
    'FAIL_CLOSED_INVALID_RESULT',
    'RECIPIENT_EMAIL_INVALID',
    'EMAIL_IDEMPOTENCY_CONFLICT',
  ];

  for (const code of internalPipelineCodes) {
    it(`code interne G5D/G5E ${code} → UNKNOWN_ERROR`, () => {
      expect(normalizeFailureCode(code)).toBe('UNKNOWN_ERROR');
    });
  }

  it('null → UNKNOWN_ERROR', () => {
    expect(normalizeFailureCode(null)).toBe('UNKNOWN_ERROR');
  });

  it('undefined → UNKNOWN_ERROR', () => {
    expect(normalizeFailureCode(undefined)).toBe('UNKNOWN_ERROR');
  });

  it('chaîne vide → UNKNOWN_ERROR', () => {
    expect(normalizeFailureCode('')).toBe('UNKNOWN_ERROR');
  });

  it('valeur inattendue aléatoire → UNKNOWN_ERROR', () => {
    expect(normalizeFailureCode('SOMETHING_UNEXPECTED')).toBe('UNKNOWN_ERROR');
  });

  it('valeur inattendue avec PII (ne doit jamais être placée telle quelle) → UNKNOWN_ERROR', () => {
    // Simule un message d'erreur brut qui ne doit JAMAIS être placé tel quel.
    expect(normalizeFailureCode('Error: email user@example.com failed')).toBe('UNKNOWN_ERROR');
  });

  it('WORKER_FAILURE_CODES contient exactement 10 codes', () => {
    expect(WORKER_FAILURE_CODES).toHaveLength(10);
  });

  it('tous les codes de WORKER_FAILURE_CODES sont normalisés vers eux-mêmes', () => {
    for (const code of WORKER_FAILURE_CODES) {
      expect(normalizeFailureCode(code)).toBe(code);
    }
  });
});
