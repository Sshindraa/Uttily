/**
 * @uttily/core — Erreurs du module Webhook Handler (Lot 5, ADR-010 §9, §10, §14).
 *
 * Codes d'erreur fermés pour le traitement des webhooks Stripe. Suivent le
 * même pattern que payment-initiation/errors.ts : une classe d'erreur typée
 * avec un code interne, un statusCode et un responseBody stable.
 *
 * Aucune donnée de carte ou secret n'apparaît dans les messages.
 */

import type { ActionErrorCode, FieldErrors } from '@uttily/contracts';

/** Codes d'erreur fermés du module webhook-handler. */
export type WebhookHandlerErrorCode =
  | 'WEBHOOK_SIGNATURE_INVALID'
  | 'WEBHOOK_TIMESTAMP_INVALID'
  | 'WEBHOOK_PAYLOAD_INVALID'
  | 'WEBHOOK_EVENT_TYPE_UNHANDLED'
  | 'WEBHOOK_ATTEMPT_NOT_FOUND'
  | 'WEBHOOK_AMOUNT_MISMATCH'
  | 'WEBHOOK_CURRENCY_MISMATCH'
  | 'WEBHOOK_ENVIRONMENT_MISMATCH'
  | 'WEBHOOK_DESTINATION_MISMATCH'
  | 'WEBHOOK_ORGANIZATION_MISMATCH'
  | 'WEBHOOK_DRAFT_NOT_PROCESSING'
  | 'WEBHOOK_ALREADY_PROCESSED'
  | 'WEBHOOK_LATE_PAYMENT'
  | 'WEBHOOK_INVARIANT_BROKEN'
  | 'WEBHOOK_AGGREGATE_INCONSISTENT'
  | 'UNKNOWN';

/**
 * Mappe un code interne `WebhookHandlerErrorCode` vers l'union fermée
 * `ActionErrorCode` utilisée par les Server Actions.
 */
export function toActionErrorCode(code: WebhookHandlerErrorCode): ActionErrorCode {
  switch (code) {
    case 'WEBHOOK_SIGNATURE_INVALID':
      return 'UNKNOWN';
    case 'WEBHOOK_TIMESTAMP_INVALID':
      return 'UNKNOWN';
    case 'WEBHOOK_PAYLOAD_INVALID':
      return 'UNKNOWN';
    case 'WEBHOOK_EVENT_TYPE_UNHANDLED':
      return 'UNKNOWN';
    case 'WEBHOOK_ATTEMPT_NOT_FOUND':
      return 'NOT_FOUND';
    case 'WEBHOOK_AMOUNT_MISMATCH':
      return 'UNKNOWN';
    case 'WEBHOOK_CURRENCY_MISMATCH':
      return 'UNKNOWN';
    case 'WEBHOOK_ENVIRONMENT_MISMATCH':
      return 'PAYMENT_ENVIRONMENT_MISMATCH';
    case 'WEBHOOK_DESTINATION_MISMATCH':
      return 'UNKNOWN';
    case 'WEBHOOK_ORGANIZATION_MISMATCH':
      return 'FORBIDDEN';
    case 'WEBHOOK_DRAFT_NOT_PROCESSING':
      return 'UNKNOWN';
    case 'WEBHOOK_ALREADY_PROCESSED':
      return 'UNKNOWN';
    case 'WEBHOOK_LATE_PAYMENT':
      return 'UNKNOWN';
    case 'WEBHOOK_INVARIANT_BROKEN':
      return 'UNKNOWN';
    case 'WEBHOOK_AGGREGATE_INCONSISTENT':
      return 'UNKNOWN';
    case 'UNKNOWN':
      return 'UNKNOWN';
  }
}

/**
 * Erreur métier typée pour le traitement des webhooks.
 *
 * Porte un `statusCode` et un `responseBody` stable. Le `client_secret` et les
 * données de carte ne doivent JAMAIS apparaître dans le message ou le responseBody.
 */
export class WebhookHandlerError extends Error {
  readonly code: WebhookHandlerErrorCode;
  readonly statusCode: number;
  readonly responseBody: { error: string; message: string };
  readonly fieldErrors?: FieldErrors | undefined;

  constructor(
    code: WebhookHandlerErrorCode,
    message: string,
    options?: {
      statusCode?: number;
      responseBody?: { error: string; message: string };
      fieldErrors?: FieldErrors;
    },
  ) {
    super(message);
    this.name = 'WebhookHandlerError';
    this.code = code;
    this.statusCode = options?.statusCode ?? 400;
    this.responseBody = options?.responseBody ?? {
      error: toActionErrorCode(code),
      message,
    };
    this.fieldErrors = options?.fieldErrors;
  }
}

/**
 * Traduit une erreur inattendue en WebhookHandlerError.
 * Retourne null si l'erreur n'est pas une erreur métier reconnue (erreur
 * technique inattendue — doit provoquer un retry Stripe).
 */
export function normalizeWebhookError(error: unknown): WebhookHandlerError | null {
  if (error instanceof WebhookHandlerError) return error;
  return null;
}

/**
 * Codes d'erreur irréconciliables : un invariant brisé ou une incohérence
 * d'agrégat qui ne peut pas être résolue par un retry Stripe. L'événement est
 * marqué FAILED avec un `failure_code` et un statut 2xx est retourné pour
 * arrêter les retries Stripe (ADR-010 amendement Phase 6 §D).
 *
 * N'inclut pas `WEBHOOK_LATE_PAYMENT` (control flow → compensation) ni
 * `WEBHOOK_ALREADY_PROCESSED` (control flow → doublon sous verrou).
 */
export const IRRECONCILABLE_ERROR_CODES = new Set<WebhookHandlerErrorCode>([
  'WEBHOOK_INVARIANT_BROKEN',
  'WEBHOOK_AGGREGATE_INCONSISTENT',
  'WEBHOOK_AMOUNT_MISMATCH',
  'WEBHOOK_CURRENCY_MISMATCH',
  'WEBHOOK_DESTINATION_MISMATCH',
  'WEBHOOK_ORGANIZATION_MISMATCH',
  'WEBHOOK_DRAFT_NOT_PROCESSING',
]);

/**
 * Détermine si une erreur est irréconciliable (invariant brisé, agrégat
 * incohérent, mismatch montant/devise/destination/org/draft). Une telle erreur
 * doit marquer l'événement webhook FAILED et retourner 2xx (pas 5xx) pour
 * arrêter les retries Stripe.
 *
 * Les erreurs de control flow (`WEBHOOK_LATE_PAYMENT`,
 * `WEBHOOK_ALREADY_PROCESSED`) ne sont PAS irréconciliables : elles sont
 * re-lancées pour être traitées par l'orchestrateur.
 */
export function isIrreconcilable(error: WebhookHandlerError): boolean {
  return IRRECONCILABLE_ERROR_CODES.has(error.code);
}
