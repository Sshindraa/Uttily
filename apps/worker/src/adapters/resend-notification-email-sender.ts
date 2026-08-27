import { Resend } from 'resend';
import type { NotificationEmailSender } from '@uttily/core';
import { NotificationSendError } from '@uttily/core';

export interface ResendNotificationConfig {
  readonly apiKey: string;
  readonly fromEmail: string;
}

export function validateResendNotificationConfig(config: ResendNotificationConfig): void {
  if (!config.apiKey || config.apiKey.trim().length === 0) {
    throw new Error('RESEND_API_KEY est requise.');
  }
  if (!config.fromEmail || config.fromEmail.trim().length === 0) {
    throw new Error('EMAIL_FROM / RESEND_FROM_EMAIL est requis.');
  }
}

export class ResendNotificationEmailSender implements NotificationEmailSender {
  private readonly resend: Resend;
  private readonly fromEmail: string;

  constructor(config: ResendNotificationConfig, resendClient?: Resend) {
    validateResendNotificationConfig(config);
    this.fromEmail = config.fromEmail.trim();
    this.resend = resendClient ?? new Resend(config.apiKey.trim());
  }

  async send(input: {
    recipient: string;
    subject: string;
    html: string;
    text: string;
    idempotencyKey: string;
  }): Promise<{ messageId: string }> {
    try {
      const response = await this.resend.emails.send(
        {
          from: this.fromEmail,
          to: input.recipient,
          subject: input.subject,
          html: input.html,
          text: input.text,
        },
        {
          idempotencyKey: input.idempotencyKey,
        },
      );

      if (response.error) {
        const errorName = response.error.name ?? 'ResendError';
        const statusCode = response.error.statusCode ?? 500;

        // Classification des erreurs retournées par l'API Resend
        if (statusCode === 429) {
          throw new NotificationSendError(
            'TRANSIENT',
            'RATE_LIMITED',
            'Limite de requêtes atteinte.',
          );
        }
        if (statusCode >= 500) {
          throw new NotificationSendError(
            'TRANSIENT',
            'PROVIDER_5XX',
            `Erreur temporaire fournisseur (${statusCode}).`,
          );
        }
        if (statusCode === 422 || statusCode === 400) {
          throw new NotificationSendError(
            'DETERMINISTIC',
            'INVALID_REQUEST',
            `Refus déterministe fournisseur (${errorName}).`,
          );
        }

        throw new NotificationSendError(
          'UNCERTAIN',
          'PROVIDER_ERROR',
          'Erreur fournisseur non classifiée.',
        );
      }

      if (!response.data?.id) {
        throw new NotificationSendError(
          'UNCERTAIN',
          'MISSING_MESSAGE_ID',
          'ID de message manquant dans la réponse.',
        );
      }

      return { messageId: response.data.id };
    } catch (err) {
      if (err instanceof NotificationSendError) {
        throw err;
      }

      const msg = err instanceof Error ? err.message : '';
      if (
        msg.includes('timeout') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('ENOTFOUND')
      ) {
        throw new NotificationSendError(
          'TRANSIENT',
          'NETWORK_TIMEOUT',
          'Erreur de connexion réseau au fournisseur.',
        );
      }

      throw new NotificationSendError(
        'UNCERTAIN',
        'UNKNOWN_EXCEPTION',
        'Exception imprévue lors de l’appel fournisseur.',
      );
    }
  }
}

export function createResendNotificationEmailSenderFromEnv(): ResendNotificationEmailSender {
  const apiKey = process.env['RESEND_API_KEY'] ?? '';
  const fromEmail =
    process.env['RESEND_FROM_EMAIL'] ??
    process.env['EMAIL_FROM'] ??
    'Uttily <notifications@uttily.com>';
  return new ResendNotificationEmailSender({ apiKey, fromEmail });
}
