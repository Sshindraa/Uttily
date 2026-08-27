import { describe, expect, it } from 'vitest';
import { Resend } from 'resend';
import {
  ResendNotificationEmailSender,
  validateResendNotificationConfig,
} from './resend-notification-email-sender';

interface CapturedEmailOptions {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

interface CapturedRequestOptions {
  idempotencyKey?: string;
}

describe('ResendNotificationEmailSender', () => {
  it('valide la configuration requise', () => {
    expect(() =>
      validateResendNotificationConfig({ apiKey: '', fromEmail: 'test@example.com' }),
    ).toThrow('RESEND_API_KEY est requise.');
    expect(() => validateResendNotificationConfig({ apiKey: 're_123', fromEmail: '' })).toThrow(
      'EMAIL_FROM / RESEND_FROM_EMAIL est requis.',
    );
    expect(() =>
      validateResendNotificationConfig({ apiKey: 're_123', fromEmail: 'test@example.com' }),
    ).not.toThrow();
  });

  it('envoie un email avec succès et transmet idempotencyKey', async () => {
    let capturedOptions: CapturedEmailOptions | undefined;
    let capturedRequestOptions: CapturedRequestOptions | undefined;

    const fakeResend = {
      emails: {
        send: (
          options: CapturedEmailOptions,
          reqOptions: CapturedRequestOptions,
        ): Promise<{ data: { id: string } | null; error: null }> => {
          capturedOptions = options;
          capturedRequestOptions = reqOptions;
          return Promise.resolve({ data: { id: 'msg_resend_123' }, error: null });
        },
      },
    } as unknown as Resend;

    const sender = new ResendNotificationEmailSender(
      { apiKey: 're_test', fromEmail: 'Uttily <hello@uttily.com>' },
      fakeResend,
    );

    const result = await sender.send({
      recipient: 'client@example.com',
      subject: 'Confirmation',
      html: '<p>Bienvenue</p>',
      text: 'Bienvenue',
      idempotencyKey: 'notif_idemp_key_1',
    });

    expect(result.messageId).toBe('msg_resend_123');
    expect(capturedOptions).toBeDefined();
    expect(capturedOptions?.from).toBe('Uttily <hello@uttily.com>');
    expect(capturedOptions?.to).toBe('client@example.com');
    expect(capturedOptions?.subject).toBe('Confirmation');
    expect(capturedRequestOptions?.idempotencyKey).toBe('notif_idemp_key_1');
  });

  it('mappe les erreurs 429 en TRANSIENT (RATE_LIMITED)', async () => {
    const fakeResend = {
      emails: {
        send: () =>
          Promise.resolve({
            data: null,
            error: { name: 'rate_limit_exceeded', statusCode: 429, message: 'Too many requests' },
          }),
      },
    } as unknown as Resend;

    const sender = new ResendNotificationEmailSender(
      { apiKey: 're_test', fromEmail: 'hello@uttily.com' },
      fakeResend,
    );

    await expect(
      sender.send({
        recipient: 'client@example.com',
        subject: 'S',
        html: '<p>H</p>',
        text: 'T',
        idempotencyKey: 'k',
      }),
    ).rejects.toMatchObject({
      category: 'TRANSIENT',
      code: 'RATE_LIMITED',
    });
  });

  it('mappe les erreurs 500+ en TRANSIENT (PROVIDER_5XX)', async () => {
    const fakeResend = {
      emails: {
        send: () =>
          Promise.resolve({
            data: null,
            error: {
              name: 'internal_server_error',
              statusCode: 503,
              message: 'Service unavailable',
            },
          }),
      },
    } as unknown as Resend;

    const sender = new ResendNotificationEmailSender(
      { apiKey: 're_test', fromEmail: 'hello@uttily.com' },
      fakeResend,
    );

    await expect(
      sender.send({
        recipient: 'client@example.com',
        subject: 'S',
        html: '<p>H</p>',
        text: 'T',
        idempotencyKey: 'k',
      }),
    ).rejects.toMatchObject({
      category: 'TRANSIENT',
      code: 'PROVIDER_5XX',
    });
  });

  it('mappe les erreurs 422 / 400 en DETERMINISTIC (INVALID_REQUEST)', async () => {
    const fakeResend = {
      emails: {
        send: () =>
          Promise.resolve({
            data: null,
            error: {
              name: 'validation_error',
              statusCode: 422,
              message: 'Invalid recipient email',
            },
          }),
      },
    } as unknown as Resend;

    const sender = new ResendNotificationEmailSender(
      { apiKey: 're_test', fromEmail: 'hello@uttily.com' },
      fakeResend,
    );

    await expect(
      sender.send({
        recipient: 'client@example.com',
        subject: 'S',
        html: '<p>H</p>',
        text: 'T',
        idempotencyKey: 'k',
      }),
    ).rejects.toMatchObject({
      category: 'DETERMINISTIC',
      code: 'INVALID_REQUEST',
    });
  });

  it('mappe ENOTFOUND et ECONNREFUSED en TRANSIENT (NETWORK_UNREACHABLE)', async () => {
    const fakeResend = {
      emails: {
        send: () => Promise.reject(new Error('getaddrinfo ENOTFOUND api.resend.com')),
      },
    } as unknown as Resend;

    const sender = new ResendNotificationEmailSender(
      { apiKey: 're_test', fromEmail: 'hello@uttily.com' },
      fakeResend,
    );

    await expect(
      sender.send({
        recipient: 'client@example.com',
        subject: 'S',
        html: '<p>H</p>',
        text: 'T',
        idempotencyKey: 'k',
      }),
    ).rejects.toMatchObject({
      category: 'TRANSIENT',
      code: 'NETWORK_UNREACHABLE',
    });
  });

  it('mappe les timeouts et coupures en UNCERTAIN (NETWORK_TIMEOUT_UNCERTAIN)', async () => {
    const fakeResend = {
      emails: {
        send: () => Promise.reject(new Error('connect ETIMEDOUT 1.2.3.4:443')),
      },
    } as unknown as Resend;

    const sender = new ResendNotificationEmailSender(
      { apiKey: 're_test', fromEmail: 'hello@uttily.com' },
      fakeResend,
    );

    await expect(
      sender.send({
        recipient: 'client@example.com',
        subject: 'S',
        html: '<p>H</p>',
        text: 'T',
        idempotencyKey: 'k',
      }),
    ).rejects.toMatchObject({
      category: 'UNCERTAIN',
      code: 'NETWORK_TIMEOUT_UNCERTAIN',
    });
  });
});
