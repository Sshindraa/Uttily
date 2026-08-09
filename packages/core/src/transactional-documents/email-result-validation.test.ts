/**
 * @uttily/core — Tests unitaires du parseur validateEmailResult (G5H-C2B, ADR-013 §13.4).
 *
 * Tests PURS : aucun PostgreSQL requis. Vérifient la validation stricte du
 * EmailSendResult (4 variantes) et l'absence de la valeur reçue dans les messages d'erreur.
 */

import { describe, expect, it } from 'vitest';
import { validateEmailResult } from './email-result-validation';

describe('validateEmailResult', () => {
  // ─── SENT ───

  it('1. SENT valide → ok avec providerMessageId', () => {
    const result = validateEmailResult({ kind: 'SENT', providerMessageId: 'msg-123' });
    expect(result.ok).toBe(true);
    expect(result.result.kind).toBe('SENT');
    expect(result.result.kind === 'SENT' && result.result.providerMessageId).toBe('msg-123');
  });

  it('2. SENT valide avec providerMessageId trimé', () => {
    const result = validateEmailResult({ kind: 'SENT', providerMessageId: '  msg-123  ' });
    expect(result.ok).toBe(true);
    expect(result.result.kind === 'SENT' && result.result.providerMessageId).toBe('msg-123');
  });

  it('3. SENT sans providerMessageId → jette', () => {
    expect(() => validateEmailResult({ kind: 'SENT' })).toThrow('EMAIL_RESULT_INVALID');
  });

  it('4. SENT avec providerMessageId non-string → jette', () => {
    expect(() => validateEmailResult({ kind: 'SENT', providerMessageId: 42 })).toThrow(
      'PROVIDER_MESSAGE_ID_INVALID',
    );
  });

  it('5. SENT avec providerMessageId vide → jette', () => {
    expect(() => validateEmailResult({ kind: 'SENT', providerMessageId: '' })).toThrow(
      'PROVIDER_MESSAGE_ID_INVALID',
    );
  });

  it('6. SENT avec propriété supplémentaire → jette', () => {
    expect(() =>
      validateEmailResult({ kind: 'SENT', providerMessageId: 'x', extra: 'bad' }),
    ).toThrow('EMAIL_RESULT_INVALID');
  });

  it('7. SENT avec failureCode → jette (propriété supplémentaire)', () => {
    expect(() =>
      validateEmailResult({ kind: 'SENT', providerMessageId: 'x', failureCode: 'X' }),
    ).toThrow('EMAIL_RESULT_INVALID');
  });

  // ─── DETERMINISTIC_REFUSAL ───

  it('8. DETERMINISTIC_REFUSAL valide (INVALID_RECIPIENT)', () => {
    const result = validateEmailResult({
      kind: 'DETERMINISTIC_REFUSAL',
      failureCode: 'INVALID_RECIPIENT',
    });
    expect(result.ok).toBe(true);
    expect(result.result.kind).toBe('DETERMINISTIC_REFUSAL');
    expect(result.result.kind === 'DETERMINISTIC_REFUSAL' && result.result.failureCode).toBe(
      'INVALID_RECIPIENT',
    );
  });

  it('9. DETERMINISTIC_REFUSAL valide (IDEMPOTENT_PAYLOAD_CONFLICT)', () => {
    const result = validateEmailResult({
      kind: 'DETERMINISTIC_REFUSAL',
      failureCode: 'IDEMPOTENT_PAYLOAD_CONFLICT',
    });
    expect(result.ok).toBe(true);
    expect(result.result.kind === 'DETERMINISTIC_REFUSAL' && result.result.failureCode).toBe(
      'IDEMPOTENT_PAYLOAD_CONFLICT',
    );
  });

  it('10. DETERMINISTIC_REFUSAL sans failureCode → jette', () => {
    expect(() => validateEmailResult({ kind: 'DETERMINISTIC_REFUSAL' })).toThrow(
      'EMAIL_RESULT_INVALID',
    );
  });

  it('11. DETERMINISTIC_REFUSAL avec failureCode invalide → jette', () => {
    expect(() =>
      validateEmailResult({ kind: 'DETERMINISTIC_REFUSAL', failureCode: 'PROVIDER_5XX' }),
    ).toThrow('EMAIL_RESULT_INVALID');
  });

  it('12. DETERMINISTIC_REFUSAL avec propriété supplémentaire → jette', () => {
    expect(() =>
      validateEmailResult({
        kind: 'DETERMINISTIC_REFUSAL',
        failureCode: 'INVALID_RECIPIENT',
        extra: 'bad',
      }),
    ).toThrow('EMAIL_RESULT_INVALID');
  });

  // ─── TRANSIENT_NOT_SENT ───

  it('13. TRANSIENT_NOT_SENT valide (PROVIDER_RATE_LIMITED)', () => {
    const result = validateEmailResult({
      kind: 'TRANSIENT_NOT_SENT',
      failureCode: 'PROVIDER_RATE_LIMITED',
    });
    expect(result.ok).toBe(true);
    expect(result.result.kind).toBe('TRANSIENT_NOT_SENT');
    expect(result.result.kind === 'TRANSIENT_NOT_SENT' && result.result.failureCode).toBe(
      'PROVIDER_RATE_LIMITED',
    );
  });

  it('14. TRANSIENT_NOT_SENT valide (CONCURRENT_IDEMPOTENT_REQUESTS)', () => {
    const result = validateEmailResult({
      kind: 'TRANSIENT_NOT_SENT',
      failureCode: 'CONCURRENT_IDEMPOTENT_REQUESTS',
    });
    expect(result.ok).toBe(true);
  });

  it('15. TRANSIENT_NOT_SENT avec failureCode invalide → jette', () => {
    expect(() =>
      validateEmailResult({ kind: 'TRANSIENT_NOT_SENT', failureCode: 'INVALID_RECIPIENT' }),
    ).toThrow('EMAIL_RESULT_INVALID');
  });

  // ─── UNCERTAIN ───

  it('16. UNCERTAIN valide (PROVIDER_5XX)', () => {
    const result = validateEmailResult({ kind: 'UNCERTAIN', failureCode: 'PROVIDER_5XX' });
    expect(result.ok).toBe(true);
    expect(result.result.kind).toBe('UNCERTAIN');
    expect(result.result.kind === 'UNCERTAIN' && result.result.failureCode).toBe('PROVIDER_5XX');
  });

  it('17. UNCERTAIN valide (UNKNOWN_FAILURE_AFTER_CALL_START)', () => {
    const result = validateEmailResult({
      kind: 'UNCERTAIN',
      failureCode: 'UNKNOWN_FAILURE_AFTER_CALL_START',
    });
    expect(result.ok).toBe(true);
  });

  it('18. UNCERTAIN avec failureCode invalide → jette', () => {
    expect(() =>
      validateEmailResult({ kind: 'UNCERTAIN', failureCode: 'PROVIDER_RATE_LIMITED' }),
    ).toThrow('EMAIL_RESULT_INVALID');
  });

  // ─── Forgery / type errors ───

  it('19. null → jette EMAIL_RESULT_INVALID', () => {
    expect(() => validateEmailResult(null)).toThrow('EMAIL_RESULT_INVALID');
  });

  it('20. undefined → jette EMAIL_RESULT_INVALID', () => {
    expect(() => validateEmailResult(undefined)).toThrow('EMAIL_RESULT_INVALID');
  });

  it('21. string → jette EMAIL_RESULT_INVALID', () => {
    expect(() => validateEmailResult('SENT')).toThrow('EMAIL_RESULT_INVALID');
  });

  it('22. number → jette EMAIL_RESULT_INVALID', () => {
    expect(() => validateEmailResult(42)).toThrow('EMAIL_RESULT_INVALID');
  });

  it('23. array → jette EMAIL_RESULT_INVALID', () => {
    expect(() => validateEmailResult([1, 2, 3])).toThrow('EMAIL_RESULT_INVALID');
  });

  it('24. kind forged → jette EMAIL_RESULT_INVALID', () => {
    expect(() => validateEmailResult({ kind: 'FORGED', failureCode: 'X' })).toThrow(
      'EMAIL_RESULT_INVALID',
    );
  });

  it('25. kind manquant → jette EMAIL_RESULT_INVALID', () => {
    expect(() => validateEmailResult({ failureCode: 'X' })).toThrow('EMAIL_RESULT_INVALID');
  });

  it('26. kind non-string → jette EMAIL_RESULT_INVALID', () => {
    expect(() => validateEmailResult({ kind: 123 })).toThrow('EMAIL_RESULT_INVALID');
  });

  // ─── Confidentialité ───

  it("27. les messages d'erreur ne contiennent JAMAIS la valeur reçue", () => {
    const sensitiveValue = 'SECRET-PROVIDER-TOKEN';
    try {
      validateEmailResult({ kind: 'SENT', providerMessageId: `${sensitiveValue}\n` });
      expect.fail('Devrait jeter');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(sensitiveValue);
    }
  });

  it("28. les messages d'erreur ne contiennent pas la valeur reçue (kind forged)", () => {
    const forgedKind = 'FORGED_SECRET_KIND';
    try {
      validateEmailResult({ kind: forgedKind, failureCode: 'X' });
      expect.fail('Devrait jeter');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(forgedKind);
    }
  });

  it("29. les messages d'erreur ne contiennent pas le failureCode forged", () => {
    const forgedCode = 'SECRET_FORGED_CODE';
    try {
      validateEmailResult({ kind: 'UNCERTAIN', failureCode: forgedCode });
      expect.fail('Devrait jeter');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(forgedCode);
    }
  });
});
