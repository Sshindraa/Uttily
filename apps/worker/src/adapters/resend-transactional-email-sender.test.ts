import { describe, it, expect } from 'vitest';
import {
  ResendTransactionalEmailSender,
  ResendConfigError,
  validateResendConfig,
  createResendConfigFromEnv,
  type ResendConfig,
  type ResendEmailsLike,
  type ResendSendPayload,
  type ResendSendOptions,
  type ResendSendResponse,
} from './resend-transactional-email-sender';

// Toutes les valeurs de test sont fictives. Aucun credential réel, aucun email réel.

const VALID_CONFIG: ResendConfig = {
  apiKey: 're_test_api_key_1234567890',
  fromEmail: 'Uttily <noreply@test.example.com>',
  bookingConfirmedTemplateId: 'tmpl_booking_confirmed_test_123',
};

const TEST_RECIPIENT = 'customer@test.example.com';
const TEST_TEMPLATE_KEY = 'booking_confirmed_customer';
const TEST_IDEMPOTENCY_KEY = 'email_provider_evt-123_SEND_EMAIL_v1';
const TEST_VARIABLES: Readonly<Record<string, string | number>> = {
  bookingId: 'booking-test-123',
  count: 42,
};

// ─────────────────────────────────────────────────────────────────────────────
// Mock client factice — capture les appels sans réseau
// ─────────────────────────────────────────────────────────────────────────────

interface CapturedCall {
  readonly payload: ResendSendPayload;
  readonly options: ResendSendOptions | undefined;
}

class MockResendEmails implements ResendEmailsLike {
  readonly capturedCalls: CapturedCall[] = [];
  private responses: ResendSendResponse[] = [];
  private callIndex = 0;
  private overrideFn:
    | ((payload: ResendSendPayload, options?: ResendSendOptions) => Promise<ResendSendResponse>)
    | undefined = undefined;

  setResponses(responses: ResendSendResponse[]): void {
    this.responses = responses;
    this.callIndex = 0;
  }

  setOverride(
    fn: (payload: ResendSendPayload, options?: ResendSendOptions) => Promise<ResendSendResponse>,
  ): void {
    this.overrideFn = fn;
  }

  async send(payload: ResendSendPayload, options?: ResendSendOptions): Promise<ResendSendResponse> {
    if (this.overrideFn) {
      return this.overrideFn(payload, options);
    }

    const capturedTemplate: ResendSendPayload['template'] = payload.template.variables
      ? {
          id: payload.template.id,
          variables: { ...payload.template.variables },
        }
      : { id: payload.template.id };
    this.capturedCalls.push({
      payload: {
        from: payload.from,
        to: payload.to,
        template: capturedTemplate,
      },
      options: options ? { ...options } : undefined,
    });

    const response = this.responses[this.callIndex];
    this.callIndex++;
    if (response === undefined) {
      throw new Error('MockResendEmails: aucune réponse configurée');
    }
    return response;
  }

  reset(): void {
    this.capturedCalls.length = 0;
    this.responses = [];
    this.callIndex = 0;
    this.overrideFn = undefined;
  }
}

// Helpers pour construire des réponses factices.

function successResponse(id: string): ResendSendResponse {
  return { data: { id }, error: null };
}

function errorResponse(
  name: string,
  statusCode: number | null,
  message = 'Resend error',
): ResendSendResponse {
  return { data: null, error: { name, statusCode, message } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ResendTransactionalEmailSender', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Configuration
  // ─────────────────────────────────────────────────────────────────────────

  describe('validateResendConfig', () => {
    it('accepte une configuration valide', () => {
      expect(() => validateResendConfig(VALID_CONFIG)).not.toThrow();
    });

    it('rejette un apiKey absent', () => {
      let caught: unknown;
      try {
        validateResendConfig({ ...VALID_CONFIG, apiKey: '' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ResendConfigError);
      expect((caught as Error).message).toContain('RESEND_API_KEY');
    });

    it('rejette un fromEmail absent', () => {
      let caught: unknown;
      try {
        validateResendConfig({ ...VALID_CONFIG, fromEmail: '' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ResendConfigError);
      expect((caught as Error).message).toContain('RESEND_FROM_EMAIL');
    });

    it('rejette un bookingConfirmedTemplateId absent', () => {
      let caught: unknown;
      try {
        validateResendConfig({ ...VALID_CONFIG, bookingConfirmedTemplateId: '' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ResendConfigError);
      expect((caught as Error).message).toContain('RESEND_BOOKING_CONFIRMED_TEMPLATE_ID');
    });

    it('rejette un apiKey sans préfixe `re_`', () => {
      let caught: unknown;
      try {
        validateResendConfig({ ...VALID_CONFIG, apiKey: 'test_api_key_1234567890' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ResendConfigError);
      expect((caught as Error).message).not.toContain('test_api_key_1234567890');
    });

    it('rejette un apiKey > 256 caractères', () => {
      let caught: unknown;
      try {
        validateResendConfig({ ...VALID_CONFIG, apiKey: `re_${'a'.repeat(255)}` });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ResendConfigError);
    });

    it('rejette un fromEmail sans @', () => {
      let caught: unknown;
      try {
        validateResendConfig({ ...VALID_CONFIG, fromEmail: 'notanemail' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ResendConfigError);
    });

    it('ne divulgue pas la valeur du fromEmail invalide', () => {
      const secret = 'secret@invalid';
      let caught: unknown;
      try {
        validateResendConfig({ ...VALID_CONFIG, fromEmail: secret });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ResendConfigError);
      expect((caught as Error).message).not.toContain(secret);
    });

    it('ne divulgue pas la valeur du apiKey', () => {
      let caught: unknown;
      try {
        validateResendConfig({
          ...VALID_CONFIG,
          apiKey: 'SUPER_SECRET_API_KEY_VALUE',
          fromEmail: '',
          bookingConfirmedTemplateId: 'tmpl_test',
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ResendConfigError);
      expect((caught as Error).message).not.toContain('SUPER_SECRET_API_KEY_VALUE');
    });
  });

  describe('createResendConfigFromEnv', () => {
    it('construit depuis des variables valides', () => {
      const config = createResendConfigFromEnv({
        RESEND_API_KEY: 're_test_api_key_1234567890',
        RESEND_FROM_EMAIL: 'noreply@test.example.com',
        RESEND_BOOKING_CONFIRMED_TEMPLATE_ID: 'tmpl_test_123',
      });
      expect(config.apiKey).toBe('re_test_api_key_1234567890');
      expect(config.fromEmail).toBe('noreply@test.example.com');
    });

    it('rejette si une variable est absente', () => {
      let caught: unknown;
      try {
        createResendConfigFromEnv({ RESEND_API_KEY: 're_test_api_key_1234567890' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ResendConfigError);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // send — mapping des 14 cas (ADR-013 §13.5)
  // ─────────────────────────────────────────────────────────────────────────

  describe('send — mapping des 14 cas', () => {
    it('1. succès avec data.id valide → SENT + providerMessageId', async () => {
      const mock = new MockResendEmails();
      mock.setResponses([successResponse('resend-msg-123')]);
      const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

      const result = await sender.send({
        recipientEmail: TEST_RECIPIENT,
        templateKey: TEST_TEMPLATE_KEY,
        providerIdempotencyKey: TEST_IDEMPOTENCY_KEY,
        variables: TEST_VARIABLES,
      });

      expect(result).toEqual({
        kind: 'SENT',
        providerMessageId: 'resend-msg-123',
      });
    });

    it('2. destinataire local invalide → DETERMINISTIC_REFUSAL / INVALID_RECIPIENT', async () => {
      const mock = new MockResendEmails();
      mock.setResponses([successResponse('resend-msg-123')]);
      const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

      const result = await sender.send({
        recipientEmail: 'not-an-email',
        templateKey: TEST_TEMPLATE_KEY,
        providerIdempotencyKey: TEST_IDEMPOTENCY_KEY,
        variables: TEST_VARIABLES,
      });

      expect(result).toEqual({
        kind: 'DETERMINISTIC_REFUSAL',
        failureCode: 'INVALID_RECIPIENT',
      });
      expect(mock.capturedCalls.length).toBe(0);
    });

    it('3. template local inconnu → DETERMINISTIC_REFUSAL / TEMPLATE_NOT_SUPPORTED', async () => {
      const mock = new MockResendEmails();
      mock.setResponses([successResponse('resend-msg-123')]);
      const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

      const result = await sender.send({
        recipientEmail: TEST_RECIPIENT,
        templateKey: 'unknown_template',
        providerIdempotencyKey: TEST_IDEMPOTENCY_KEY,
        variables: TEST_VARIABLES,
      });

      expect(result).toEqual({
        kind: 'DETERMINISTIC_REFUSAL',
        failureCode: 'TEMPLATE_NOT_SUPPORTED',
      });
      expect(mock.capturedCalls.length).toBe(0);
    });

    it('4. invalid_idempotency_key → DETERMINISTIC_REFUSAL / PROVIDER_REFUSED_DETERMINISTIC', async () => {
      const mock = new MockResendEmails();
      mock.setResponses([errorResponse('invalid_idempotency_key', 400)]);
      const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

      const result = await sender.send({
        recipientEmail: TEST_RECIPIENT,
        templateKey: TEST_TEMPLATE_KEY,
        providerIdempotencyKey: TEST_IDEMPOTENCY_KEY,
        variables: TEST_VARIABLES,
      });

      expect(result).toEqual({
        kind: 'DETERMINISTIC_REFUSAL',
        failureCode: 'PROVIDER_REFUSED_DETERMINISTIC',
      });
    });

    it('5. invalid_idempotent_request → DETERMINISTIC_REFUSAL / IDEMPOTENT_PAYLOAD_CONFLICT', async () => {
      const mock = new MockResendEmails();
      mock.setResponses([errorResponse('invalid_idempotent_request', 409)]);
      const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

      const result = await sender.send({
        recipientEmail: TEST_RECIPIENT,
        templateKey: TEST_TEMPLATE_KEY,
        providerIdempotencyKey: TEST_IDEMPOTENCY_KEY,
        variables: TEST_VARIABLES,
      });

      expect(result).toEqual({
        kind: 'DETERMINISTIC_REFUSAL',
        failureCode: 'IDEMPOTENT_PAYLOAD_CONFLICT',
      });
    });

    it('6. concurrent_idempotent_requests → TRANSIENT_NOT_SENT / CONCURRENT_IDEMPOTENT_REQUESTS', async () => {
      const mock = new MockResendEmails();
      mock.setResponses([errorResponse('concurrent_idempotent_requests', 409)]);
      const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

      const result = await sender.send({
        recipientEmail: TEST_RECIPIENT,
        templateKey: TEST_TEMPLATE_KEY,
        providerIdempotencyKey: TEST_IDEMPOTENCY_KEY,
        variables: TEST_VARIABLES,
      });

      expect(result).toEqual({
        kind: 'TRANSIENT_NOT_SENT',
        failureCode: 'CONCURRENT_IDEMPOTENT_REQUESTS',
      });
    });

    it('7. 400 générique, 401, 403, 404 ou 422 → DETERMINISTIC_REFUSAL / PROVIDER_REFUSED_DETERMINISTIC', async () => {
      const codes = [400, 401, 403, 404, 422];
      for (const statusCode of codes) {
        const mock = new MockResendEmails();
        mock.setResponses([errorResponse('generic_error', statusCode)]);
        const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

        const result = await sender.send({
          recipientEmail: TEST_RECIPIENT,
          templateKey: TEST_TEMPLATE_KEY,
          providerIdempotencyKey: TEST_IDEMPOTENCY_KEY,
          variables: TEST_VARIABLES,
        });

        expect(result).toEqual({
          kind: 'DETERMINISTIC_REFUSAL',
          failureCode: 'PROVIDER_REFUSED_DETERMINISTIC',
        });
      }
    });

    it('8. 429 → TRANSIENT_NOT_SENT / PROVIDER_RATE_LIMITED', async () => {
      const mock = new MockResendEmails();
      mock.setResponses([errorResponse('rate_limit_exceeded', 429)]);
      const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

      const result = await sender.send({
        recipientEmail: TEST_RECIPIENT,
        templateKey: TEST_TEMPLATE_KEY,
        providerIdempotencyKey: TEST_IDEMPOTENCY_KEY,
        variables: TEST_VARIABLES,
      });

      expect(result).toEqual({
        kind: 'TRANSIENT_NOT_SENT',
        failureCode: 'PROVIDER_RATE_LIMITED',
      });
    });

    it('9. 5xx → UNCERTAIN / PROVIDER_5XX', async () => {
      const mock = new MockResendEmails();
      mock.setResponses([errorResponse('internal_server_error', 503)]);
      const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

      const result = await sender.send({
        recipientEmail: TEST_RECIPIENT,
        templateKey: TEST_TEMPLATE_KEY,
        providerIdempotencyKey: TEST_IDEMPOTENCY_KEY,
        variables: TEST_VARIABLES,
      });

      expect(result).toEqual({
        kind: 'UNCERTAIN',
        failureCode: 'PROVIDER_5XX',
      });
    });

    it('10. timeout structuré identifiable (AbortError, ETIMEDOUT, ECONNABORTED) → UNCERTAIN / PROVIDER_TIMEOUT', async () => {
      const cases = [{ name: 'AbortError' }, { code: 'ETIMEDOUT' }, { code: 'ECONNABORTED' }];
      for (const testCase of cases) {
        const mock = new MockResendEmails();
        mock.setOverride(async () => {
          const err = new Error('timeout simulation');
          if (testCase.name) {
            err.name = testCase.name;
          }
          if (testCase.code) {
            (err as Error & { code?: string }).code = testCase.code;
          }
          throw err;
        });
        const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

        const result = await sender.send({
          recipientEmail: TEST_RECIPIENT,
          templateKey: TEST_TEMPLATE_KEY,
          providerIdempotencyKey: TEST_IDEMPOTENCY_KEY,
          variables: TEST_VARIABLES,
        });

        expect(result).toEqual({
          kind: 'UNCERTAIN',
          failureCode: 'PROVIDER_TIMEOUT',
        });
      }
    });

    it('11. erreur réseau structurée identifiable → UNCERTAIN / PROVIDER_NETWORK_ERROR', async () => {
      const codes = ['ENOTFOUND', 'ECONNRESET', 'EPIPE', 'ECONNREFUSED'];
      for (const code of codes) {
        const mock = new MockResendEmails();
        mock.setOverride(async () => {
          const err = new Error('network simulation');
          (err as Error & { code?: string }).code = code;
          throw err;
        });
        const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

        const result = await sender.send({
          recipientEmail: TEST_RECIPIENT,
          templateKey: TEST_TEMPLATE_KEY,
          providerIdempotencyKey: TEST_IDEMPOTENCY_KEY,
          variables: TEST_VARIABLES,
        });

        expect(result).toEqual({
          kind: 'UNCERTAIN',
          failureCode: 'PROVIDER_NETWORK_ERROR',
        });
      }
    });

    it('12. réponse nulle, incohérente ou sans ID valide → UNCERTAIN / PROVIDER_INVALID_RESPONSE', async () => {
      const mock = new MockResendEmails();
      mock.setResponses([
        { data: { id: '' }, error: null },
        { data: null, error: null },
        null as unknown as ResendSendResponse,
      ]);
      const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

      for (let i = 0; i < 3; i++) {
        const result = await sender.send({
          recipientEmail: TEST_RECIPIENT,
          templateKey: TEST_TEMPLATE_KEY,
          providerIdempotencyKey: `${TEST_IDEMPOTENCY_KEY}-${i}`,
          variables: TEST_VARIABLES,
        });

        expect(result).toEqual({
          kind: 'UNCERTAIN',
          failureCode: 'PROVIDER_INVALID_RESPONSE',
        });
      }
    });

    it('13. exception inconnue Error → UNCERTAIN / UNKNOWN_FAILURE_AFTER_CALL_START', async () => {
      const mock = new MockResendEmails();
      mock.setOverride(async () => {
        throw new Error('unexpected internal failure');
      });
      const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

      const result = await sender.send({
        recipientEmail: TEST_RECIPIENT,
        templateKey: TEST_TEMPLATE_KEY,
        providerIdempotencyKey: TEST_IDEMPOTENCY_KEY,
        variables: TEST_VARIABLES,
      });

      expect(result).toEqual({
        kind: 'UNCERTAIN',
        failureCode: 'UNKNOWN_FAILURE_AFTER_CALL_START',
      });
    });

    it('14. exception non-Error (string) → UNCERTAIN / UNKNOWN_FAILURE_AFTER_CALL_START', async () => {
      const mock = new MockResendEmails();
      mock.setOverride(async () => {
        throw 'string error';
      });
      const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

      const result = await sender.send({
        recipientEmail: TEST_RECIPIENT,
        templateKey: TEST_TEMPLATE_KEY,
        providerIdempotencyKey: TEST_IDEMPOTENCY_KEY,
        variables: TEST_VARIABLES,
      });

      expect(result).toEqual({
        kind: 'UNCERTAIN',
        failureCode: 'UNKNOWN_FAILURE_AFTER_CALL_START',
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // send — validation locale
  // ─────────────────────────────────────────────────────────────────────────

  describe('send — validation locale', () => {
    it('recipientEmail invalide → INVALID_RECIPIENT, sans appel', async () => {
      const mock = new MockResendEmails();
      mock.setResponses([successResponse('msg-123')]);
      const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

      const result = await sender.send({
        recipientEmail: '',
        templateKey: TEST_TEMPLATE_KEY,
        providerIdempotencyKey: TEST_IDEMPOTENCY_KEY,
        variables: TEST_VARIABLES,
      });

      expect(result).toEqual({
        kind: 'DETERMINISTIC_REFUSAL',
        failureCode: 'INVALID_RECIPIENT',
      });
      expect(mock.capturedCalls.length).toBe(0);
    });

    it('providerIdempotencyKey trop longue → PROVIDER_REFUSED_DETERMINISTIC, sans appel', async () => {
      const mock = new MockResendEmails();
      mock.setResponses([successResponse('msg-123')]);
      const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

      const result = await sender.send({
        recipientEmail: TEST_RECIPIENT,
        templateKey: TEST_TEMPLATE_KEY,
        providerIdempotencyKey: 'a'.repeat(257),
        variables: TEST_VARIABLES,
      });

      expect(result).toEqual({
        kind: 'DETERMINISTIC_REFUSAL',
        failureCode: 'PROVIDER_REFUSED_DETERMINISTIC',
      });
      expect(mock.capturedCalls.length).toBe(0);
    });

    it('variables invalides → PROVIDER_REFUSED_DETERMINISTIC, sans appel', async () => {
      const mock = new MockResendEmails();
      mock.setResponses([successResponse('msg-123')]);
      const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

      const result = await sender.send({
        recipientEmail: TEST_RECIPIENT,
        templateKey: TEST_TEMPLATE_KEY,
        providerIdempotencyKey: TEST_IDEMPOTENCY_KEY,
        variables: { 'booking!': 'value' },
      });

      expect(result).toEqual({
        kind: 'DETERMINISTIC_REFUSAL',
        failureCode: 'PROVIDER_REFUSED_DETERMINISTIC',
      });
      expect(mock.capturedCalls.length).toBe(0);
    });

    it('nom de variable réservé rejeté avant appel', async () => {
      const mock = new MockResendEmails();
      mock.setResponses([successResponse('msg-123')]);
      const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

      const result = await sender.send({
        recipientEmail: TEST_RECIPIENT,
        templateKey: TEST_TEMPLATE_KEY,
        providerIdempotencyKey: TEST_IDEMPOTENCY_KEY,
        variables: { FIRST_NAME: 'value' },
      });

      expect(result).toEqual({
        kind: 'DETERMINISTIC_REFUSAL',
        failureCode: 'PROVIDER_REFUSED_DETERMINISTIC',
      });
      expect(mock.capturedCalls.length).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // send — payload et idempotence
  // ─────────────────────────────────────────────────────────────────────────

  describe('send — payload et idempotence', () => {
    it('transmet exactement from, to, template.id et variables', async () => {
      const mock = new MockResendEmails();
      mock.setResponses([successResponse('msg-123')]);
      const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

      await sender.send({
        recipientEmail: TEST_RECIPIENT,
        templateKey: TEST_TEMPLATE_KEY,
        providerIdempotencyKey: TEST_IDEMPOTENCY_KEY,
        variables: TEST_VARIABLES,
      });

      const payload = mock.capturedCalls[0]!.payload;
      expect(payload.from).toBe(VALID_CONFIG.fromEmail);
      expect(payload.to).toBe(TEST_RECIPIENT);
      expect(payload.template.id).toBe(VALID_CONFIG.bookingConfirmedTemplateId);
      expect(payload.template.variables).toEqual({
        bookingId: 'booking-test-123',
        count: 42,
      });
    });

    it('transmet la même providerIdempotencyKey dans les options', async () => {
      const mock = new MockResendEmails();
      mock.setResponses([successResponse('msg-123')]);
      const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

      await sender.send({
        recipientEmail: TEST_RECIPIENT,
        templateKey: TEST_TEMPLATE_KEY,
        providerIdempotencyKey: TEST_IDEMPOTENCY_KEY,
        variables: TEST_VARIABLES,
      });

      expect(mock.capturedCalls[0]!.options).toEqual({
        idempotencyKey: TEST_IDEMPOTENCY_KEY,
      });
    });

    it('effectue exactement un seul appel fournisseur par send', async () => {
      const mock = new MockResendEmails();
      mock.setResponses([successResponse('msg-123')]);
      const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

      await sender.send({
        recipientEmail: TEST_RECIPIENT,
        templateKey: TEST_TEMPLATE_KEY,
        providerIdempotencyKey: TEST_IDEMPOTENCY_KEY,
        variables: TEST_VARIABLES,
      });

      expect(mock.capturedCalls.length).toBe(1);
    });

    it("copie défensive des variables — l'input modifié après send n'affecte pas le payload", async () => {
      const mock = new MockResendEmails();
      mock.setResponses([successResponse('msg-123')]);
      const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

      const inputVariables: Record<string, string | number> = { bookingId: 'booking-123' };
      await sender.send({
        recipientEmail: TEST_RECIPIENT,
        templateKey: TEST_TEMPLATE_KEY,
        providerIdempotencyKey: TEST_IDEMPOTENCY_KEY,
        variables: inputVariables,
      });

      inputVariables.bookingId = 'modified';

      expect(mock.capturedCalls[0]!.payload.template.variables).toEqual({
        bookingId: 'booking-123',
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // send — confidentialité
  // ─────────────────────────────────────────────────────────────────────────

  describe('send — confidentialité des résultats', () => {
    it('un résultat SENT ne contient que kind et providerMessageId', async () => {
      const mock = new MockResendEmails();
      mock.setResponses([successResponse('resend-msg-123')]);
      const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

      const result = await sender.send({
        recipientEmail: TEST_RECIPIENT,
        templateKey: TEST_TEMPLATE_KEY,
        providerIdempotencyKey: TEST_IDEMPOTENCY_KEY,
        variables: TEST_VARIABLES,
      });

      expect(Object.keys(result).sort()).toEqual(['kind', 'providerMessageId']);
      expect(JSON.stringify(result)).not.toContain(TEST_RECIPIENT);
      expect(JSON.stringify(result)).not.toContain(VALID_CONFIG.bookingConfirmedTemplateId);
      expect(JSON.stringify(result)).not.toContain(VALID_CONFIG.apiKey);
      expect(JSON.stringify(result)).not.toContain(TEST_IDEMPOTENCY_KEY);
      expect(JSON.stringify(result)).not.toContain('booking-test-123');
    });

    it("un résultat d'échec ne contient aucun message brut, PII, secret ou payload", async () => {
      const mock = new MockResendEmails();
      mock.setResponses([
        errorResponse('missing_required_field', 400, 'Sensitive Resend error text'),
      ]);
      const sender = new ResendTransactionalEmailSender(VALID_CONFIG, mock);

      const result = await sender.send({
        recipientEmail: TEST_RECIPIENT,
        templateKey: TEST_TEMPLATE_KEY,
        providerIdempotencyKey: TEST_IDEMPOTENCY_KEY,
        variables: TEST_VARIABLES,
      });

      expect(result.kind).toBe('DETERMINISTIC_REFUSAL');
      expect(Object.keys(result).sort()).toEqual(['failureCode', 'kind']);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(TEST_RECIPIENT);
      expect(serialized).not.toContain(VALID_CONFIG.bookingConfirmedTemplateId);
      expect(serialized).not.toContain(VALID_CONFIG.apiKey);
      expect(serialized).not.toContain(TEST_IDEMPOTENCY_KEY);
      expect(serialized).not.toContain('booking-test-123');
      expect(serialized).not.toContain('Sensitive Resend error text');
      expect(serialized).not.toContain('missing_required_field');
    });
  });
});
