/**
 * @uttily/core — Tests unitaires du FakeTransactionalEmailSender (G5H-C2B, ADR-013 §13.4).
 *
 * Tests PURS : aucun PostgreSQL requis. Vérifient l'idempotence, la déduplication,
 * la détection de conflit, l'injection de résultats, la copie défensive, l'absence
 * de PII dans les erreurs, le reset, et l'empreinte canonique.
 */

import { describe, expect, it } from 'vitest';
import { FakeTransactionalEmailSender } from './fake-transactional-email-sender';
import type { EmailInput, EmailSendResult } from './types';

const SAMPLE_INPUT: EmailInput = {
  recipientEmail: 'customer@example.com',
  templateKey: 'booking_confirmed_customer',
  providerIdempotencyKey: 'email_provider_event-123_SEND_EMAIL_v1',
  variables: { bookingId: 'booking-456' },
};

describe('FakeTransactionalEmailSender', () => {
  it('1. premier send → SENT avec providerMessageId non vide', async () => {
    const sender = new FakeTransactionalEmailSender();
    const result = await sender.send(SAMPLE_INPUT);
    expect(result.kind).toBe('SENT');
    expect(result.kind === 'SENT' && result.providerMessageId).toBeTruthy();
    expect(result.kind === 'SENT' && result.providerMessageId).toBe(
      'fake-msg-email_provider_event-123_SEND_EMAIL_v1',
    );
  });

  it('2. replay même clé + même payload → même providerMessageId', async () => {
    const sender = new FakeTransactionalEmailSender();
    const result1 = await sender.send(SAMPLE_INPUT);
    const result2 = await sender.send(SAMPLE_INPUT);
    expect(result2.kind).toBe('SENT');
    expect(
      result1.kind === 'SENT' &&
        result2.kind === 'SENT' &&
        result2.providerMessageId === result1.providerMessageId,
    ).toBe(true);
  });

  it('3. uniqueEmailCount === 1 après replay', async () => {
    const sender = new FakeTransactionalEmailSender();
    await sender.send(SAMPLE_INPUT);
    await sender.send(SAMPLE_INPUT);
    expect(sender.uniqueEmailCount).toBe(1);
  });

  it('4. sendCallCount === 2 après replay (appels techniques ≠ emails logiques)', async () => {
    const sender = new FakeTransactionalEmailSender();
    await sender.send(SAMPLE_INPUT);
    await sender.send(SAMPLE_INPUT);
    expect(sender.sendCallCount).toBe(2);
    expect(sender.uniqueEmailCount).toBe(1);
  });

  it('5. même clé + payload différent → DETERMINISTIC_REFUSAL / IDEMPOTENT_PAYLOAD_CONFLICT', async () => {
    const sender = new FakeTransactionalEmailSender();
    await sender.send(SAMPLE_INPUT);
    const differentPayload: EmailInput = {
      ...SAMPLE_INPUT,
      recipientEmail: 'other@example.com',
    };
    const result = await sender.send(differentPayload);
    expect(result.kind).toBe('DETERMINISTIC_REFUSAL');
    expect(result.kind === 'DETERMINISTIC_REFUSAL' && result.failureCode).toBe(
      'IDEMPOTENT_PAYLOAD_CONFLICT',
    );
    expect(sender.failedCount).toBe(1);
  });

  it('6. injection UNCERTAIN → retourne UNCERTAIN', async () => {
    const sender = new FakeTransactionalEmailSender();
    sender.setNextResult({ kind: 'UNCERTAIN', failureCode: 'PROVIDER_5XX' });
    const result = await sender.send(SAMPLE_INPUT);
    expect(result.kind).toBe('UNCERTAIN');
    expect(result.kind === 'UNCERTAIN' && result.failureCode).toBe('PROVIDER_5XX');
    expect(sender.failedCount).toBe(1);
  });

  it('7. injection TRANSIENT_NOT_SENT → retourne TRANSIENT_NOT_SENT', async () => {
    const sender = new FakeTransactionalEmailSender();
    sender.setNextResult({ kind: 'TRANSIENT_NOT_SENT', failureCode: 'PROVIDER_RATE_LIMITED' });
    const result = await sender.send(SAMPLE_INPUT);
    expect(result.kind).toBe('TRANSIENT_NOT_SENT');
    expect(result.kind === 'TRANSIENT_NOT_SENT' && result.failureCode).toBe(
      'PROVIDER_RATE_LIMITED',
    );
  });

  it('8. injection DETERMINISTIC_REFUSAL → retourne DETERMINISTIC_REFUSAL', async () => {
    const sender = new FakeTransactionalEmailSender();
    sender.setNextResult({
      kind: 'DETERMINISTIC_REFUSAL',
      failureCode: 'INVALID_RECIPIENT',
    });
    const result = await sender.send(SAMPLE_INPUT);
    expect(result.kind).toBe('DETERMINISTIC_REFUSAL');
    expect(result.kind === 'DETERMINISTIC_REFUSAL' && result.failureCode).toBe('INVALID_RECIPIENT');
  });

  it('9. injection THROW_ERROR → jette Error', async () => {
    const sender = new FakeTransactionalEmailSender();
    sender.setNextResult({ kind: 'THROW_ERROR' });
    await expect(sender.send(SAMPLE_INPUT)).rejects.toThrow('INJECTED_ERROR');
    expect(sender.failedCount).toBe(1);
  });

  it('10. injection THROW_NON_ERROR → jette non-Error', async () => {
    const sender = new FakeTransactionalEmailSender();
    sender.setNextResult({ kind: 'THROW_NON_ERROR' });
    await expect(sender.send(SAMPLE_INPUT)).rejects.toBe('INJECTED_NON_ERROR');
    expect(sender.failedCount).toBe(1);
  });

  it('11. injection consommée puis send normal', async () => {
    const sender = new FakeTransactionalEmailSender();
    sender.setNextResult({ kind: 'UNCERTAIN', failureCode: 'PROVIDER_5XX' });
    await sender.send(SAMPLE_INPUT);
    // Deuxième appel sans injection → SENT normal.
    const result = await sender.send(SAMPLE_INPUT);
    expect(result.kind).toBe('SENT');
  });

  it("12. copie défensive : modifier l'input après send ne modifie pas la copie interne", async () => {
    const sender = new FakeTransactionalEmailSender();
    const input = {
      recipientEmail: 'test@example.com',
      templateKey: 'booking_confirmed_customer',
      providerIdempotencyKey: 'key-defensive',
      variables: { bookingId: 'bk-1' },
    } as EmailInput;
    await sender.send(input);
    // Modifier l'input original (cast pour bypass readonly).
    (input as { recipientEmail: string }).recipientEmail = 'mutated@example.com';
    (input.variables as Record<string, string | number>).bookingId = 'mutated-bk';
    // La copie interne ne doit pas être modifiée.
    expect(sender.calls[0]!.recipientEmail).toBe('test@example.com');
    expect(sender.calls[0]!.variables).toEqual({ bookingId: 'bk-1' });
  });

  it('12b. copie défensive : modifier une valeur retournée par calls ne corrompt pas une nouvelle accès', async () => {
    const sender = new FakeTransactionalEmailSender();
    await sender.send(SAMPLE_INPUT);
    // Récupérer une copie via calls et la muter (cast pour bypass readonly).
    const firstCall = sender.calls[0]!;
    (firstCall as { recipientEmail: string }).recipientEmail = 'corrupted@example.com';
    (firstCall.variables as Record<string, string | number>).bookingId = 'corrupted';
    // Une nouvelle accès doit retourner une copie non mutée.
    const freshCall = sender.calls[0]!;
    expect(freshCall.recipientEmail).toBe('customer@example.com');
    expect(freshCall.variables).toEqual({ bookingId: 'booking-456' });
  });

  it('13. providerIdempotencyKey vide → DETERMINISTIC_REFUSAL / PROVIDER_REFUSED_DETERMINISTIC', async () => {
    const sender = new FakeTransactionalEmailSender();
    const emptyKeyInput: EmailInput = {
      ...SAMPLE_INPUT,
      providerIdempotencyKey: '',
    };
    const result = await sender.send(emptyKeyInput);
    expect(result.kind).toBe('DETERMINISTIC_REFUSAL');
    expect(result.kind === 'DETERMINISTIC_REFUSAL' && result.failureCode).toBe(
      'PROVIDER_REFUSED_DETERMINISTIC',
    );
    expect(sender.failedCount).toBe(1);
    expect(sender.sendCallCount).toBe(1);
  });

  it('13b. providerIdempotencyKey avec espaces uniquement → DETERMINISTIC_REFUSAL', async () => {
    const sender = new FakeTransactionalEmailSender();
    const whitespaceKeyInput: EmailInput = {
      ...SAMPLE_INPUT,
      providerIdempotencyKey: '   ',
    };
    const result = await sender.send(whitespaceKeyInput);
    expect(result.kind).toBe('DETERMINISTIC_REFUSAL');
    expect(result.kind === 'DETERMINISTIC_REFUSAL' && result.failureCode).toBe(
      'PROVIDER_REFUSED_DETERMINISTIC',
    );
    expect(sender.failedCount).toBe(1);
  });

  it("14. aucun PII dans les messages d'erreur (THROW_ERROR)", async () => {
    const sender = new FakeTransactionalEmailSender();
    const email = 'sensitive-pii@example.com';
    const input: EmailInput = {
      ...SAMPLE_INPUT,
      recipientEmail: email,
      providerIdempotencyKey: 'key-pii-test',
    };
    sender.setNextResult({ kind: 'THROW_ERROR' });
    try {
      await sender.send(input);
      expect.fail('Devrait lever une erreur');
    } catch (error) {
      const msg = (error as Error).toString();
      // L'email ne doit PAS apparaître dans le message d'erreur.
      expect(msg).not.toContain(email);
    }
  });

  it('15. returnInvalidResultNext → retourne SENT avec providerMessageId vide', async () => {
    const sender = new FakeTransactionalEmailSender();
    sender.returnInvalidResultNext();
    const result = await sender.send(SAMPLE_INPUT);
    expect(result.kind).toBe('SENT');
    expect(result.kind === 'SENT' && result.providerMessageId).toBe('');
    // Un SENT invalide n'est PAS stocké comme email accepté.
    expect(sender.uniqueEmailCount).toBe(0);
    expect(sender.failedCount).toBe(0);
  });

  it("16. reset() efface tout l'état", async () => {
    const sender = new FakeTransactionalEmailSender();
    await sender.send(SAMPLE_INPUT);
    expect(sender.uniqueEmailCount).toBe(1);
    expect(sender.sendCallCount).toBe(1);
    sender.reset();
    expect(sender.uniqueEmailCount).toBe(0);
    expect(sender.sendCallCount).toBe(0);
    expect(sender.failedCount).toBe(0);
    // Après reset, un nouvel envoi est un nouveau email logique.
    const result = await sender.send(SAMPLE_INPUT);
    expect(result.kind).toBe('SENT');
    expect(sender.uniqueEmailCount).toBe(1);
  });

  it('17. wasSent et getProviderMessageId fonctionnent correctement', async () => {
    const sender = new FakeTransactionalEmailSender();
    expect(sender.wasSent(SAMPLE_INPUT.providerIdempotencyKey)).toBe(false);
    const result = await sender.send(SAMPLE_INPUT);
    expect(sender.wasSent(SAMPLE_INPUT.providerIdempotencyKey)).toBe(true);
    expect(sender.getProviderMessageId(SAMPLE_INPUT.providerIdempotencyKey)).toBe(
      result.kind === 'SENT' ? result.providerMessageId : undefined,
    );
    expect(sender.getProviderMessageId('nonexistent-key')).toBeUndefined();
  });

  it('18. préfixe personnalisé du messageId', async () => {
    const sender = new FakeTransactionalEmailSender({ messageIdPrefix: 'custom-prefix-' });
    const result = await sender.send(SAMPLE_INPUT);
    expect(result.kind === 'SENT' && result.providerMessageId).toBe(
      'custom-prefix-email_provider_event-123_SEND_EMAIL_v1',
    );
  });

  it('19. failNext(3) jette 3 fois puis réussit', async () => {
    const sender = new FakeTransactionalEmailSender();
    sender.failNext(3);
    for (let i = 0; i < 3; i++) {
      await expect(sender.send(SAMPLE_INPUT)).rejects.toThrow('EMAIL_SEND_FAILED');
    }
    expect(sender.failedCount).toBe(3);
    expect(sender.sendCallCount).toBe(3);
    // Le 4e appel réussit.
    const result = await sender.send(SAMPLE_INPUT);
    expect(result.kind).toBe('SENT');
    expect(sender.failedCount).toBe(3);
    expect(sender.uniqueEmailCount).toBe(1);
  });

  it("20. injection SENT stocke l'email pour replay ultérieur", async () => {
    const sender = new FakeTransactionalEmailSender();
    const sentResult: EmailSendResult = { kind: 'SENT', providerMessageId: 'injected-id-123' };
    sender.setNextResult(sentResult);
    await sender.send(SAMPLE_INPUT);
    // Replay avec même clé + même payload → même providerMessageId.
    const result2 = await sender.send(SAMPLE_INPUT);
    expect(result2.kind).toBe('SENT');
    expect(result2.kind === 'SENT' && result2.providerMessageId).toBe('injected-id-123');
  });

  it("21. injection non-SENT ne stocke pas l'email", async () => {
    const sender = new FakeTransactionalEmailSender();
    sender.setNextResult({ kind: 'UNCERTAIN', failureCode: 'PROVIDER_5XX' });
    await sender.send(SAMPLE_INPUT);
    expect(sender.wasSent(SAMPLE_INPUT.providerIdempotencyKey)).toBe(false);
    // Deuxième appel sans injection → SENT normal (nouvel email).
    const result = await sender.send(SAMPLE_INPUT);
    expect(result.kind).toBe('SENT');
    expect(sender.wasSent(SAMPLE_INPUT.providerIdempotencyKey)).toBe(true);
  });

  it('22. setNextResults avec EmailSendResult, Error et non-Error', async () => {
    const sender = new FakeTransactionalEmailSender();
    const customError = new Error('EMAIL_SEND_FAILED: erreur injectée explicitement');
    sender.setNextResults([
      { kind: 'DETERMINISTIC_REFUSAL', failureCode: 'TEMPLATE_NOT_SUPPORTED' },
      customError,
      'string-injectée',
    ]);

    const result1 = await sender.send(SAMPLE_INPUT);
    expect(result1.kind).toBe('DETERMINISTIC_REFUSAL');
    expect(result1.kind === 'DETERMINISTIC_REFUSAL' && result1.failureCode).toBe(
      'TEMPLATE_NOT_SUPPORTED',
    );
    expect(sender.failedCount).toBe(1);

    await expect(sender.send(SAMPLE_INPUT)).rejects.toThrow(customError);
    expect(sender.failedCount).toBe(2);

    await expect(sender.send(SAMPLE_INPUT)).rejects.toBe('string-injectée');
    expect(sender.failedCount).toBe(3);
  });

  it("23. setNextResults avec SENT stocke l'email", async () => {
    const sender = new FakeTransactionalEmailSender();
    sender.setNextResults([{ kind: 'SENT', providerMessageId: 'batch-1' }]);
    const result = await sender.send(SAMPLE_INPUT);
    expect(result.kind === 'SENT' && result.providerMessageId).toBe('batch-1');
    expect(sender.wasSent(SAMPLE_INPUT.providerIdempotencyKey)).toBe(true);
    expect(sender.uniqueEmailCount).toBe(1);
  });
});
