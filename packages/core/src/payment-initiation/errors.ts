import type { ActionErrorCode, FieldErrors } from '@uttily/contracts';

/**
 * Codes d'erreur fermés du module payment-initiation.
 *
 * Ces codes sont internes au module et mappés vers `ActionErrorCode` lors de
 * la persistance dans idempotency_records et lors de la projection vers
 * ActionResult par les Server Actions.
 */
export type PaymentInitiationErrorCode =
  | 'VALIDATION'
  | 'DRAFT_NOT_FOUND'
  | 'DRAFT_EXPIRED'
  | 'DRAFT_NOT_HELD'
  | 'DRAFT_ALREADY_PROCESSING_INCONSISTENT'
  | 'ORGANIZATION_MISMATCH'
  | 'CUSTOMER_MISMATCH'
  | 'FINANCIAL_TERMS_UNRESOLVED'
  | 'CONNECTED_ACCOUNT_NOT_FOUND'
  | 'CONNECTED_ACCOUNT_NOT_READY'
  | 'CONNECTED_ACCOUNT_ENVIRONMENT_MISMATCH'
  | 'CONNECTED_ACCOUNT_TRANSFERS_INACTIVE'
  | 'CURRENCY_NOT_EUR'
  | 'ENVIRONMENT_MISMATCH'
  | 'ALLOCATION_INCONSISTENT'
  | 'HOLD_INCONSISTENT'
  | 'PROVIDER_CALL_FAILED'
  | 'PROVIDER_STATE_INCONSISTENT'
  | 'ATTEMPT_TERMINAL_RECONCILIATION_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'UNKNOWN';

/**
 * Mappe un code interne `PaymentInitiationErrorCode` vers l'union fermée
 * `ActionErrorCode` utilisée par les Server Actions et persistée dans
 * idempotency_records.
 */
export function toActionErrorCode(code: PaymentInitiationErrorCode): ActionErrorCode {
  switch (code) {
    case 'VALIDATION':
      return 'VALIDATION';
    case 'DRAFT_NOT_FOUND':
      return 'NOT_FOUND';
    case 'DRAFT_EXPIRED':
      return 'VALIDATION';
    case 'DRAFT_NOT_HELD':
      return 'VALIDATION';
    case 'DRAFT_ALREADY_PROCESSING_INCONSISTENT':
      return 'UNKNOWN';
    case 'ORGANIZATION_MISMATCH':
      return 'FORBIDDEN';
    case 'CUSTOMER_MISMATCH':
      return 'FORBIDDEN';
    case 'FINANCIAL_TERMS_UNRESOLVED':
      return 'FINANCIAL_TERMS_UNRESOLVED';
    case 'CONNECTED_ACCOUNT_NOT_FOUND':
      return 'NOT_FOUND';
    case 'CONNECTED_ACCOUNT_NOT_READY':
      return 'PAYMENT_ACCOUNT_NOT_READY';
    case 'CONNECTED_ACCOUNT_ENVIRONMENT_MISMATCH':
      return 'PAYMENT_ENVIRONMENT_MISMATCH';
    case 'CONNECTED_ACCOUNT_TRANSFERS_INACTIVE':
      return 'PAYMENT_ACCOUNT_NOT_READY';
    case 'CURRENCY_NOT_EUR':
      return 'VALIDATION';
    case 'ENVIRONMENT_MISMATCH':
      return 'PAYMENT_ENVIRONMENT_MISMATCH';
    case 'ALLOCATION_INCONSISTENT':
      return 'UNKNOWN';
    case 'HOLD_INCONSISTENT':
      return 'UNKNOWN';
    case 'PROVIDER_CALL_FAILED':
      return 'UNKNOWN';
    case 'PROVIDER_STATE_INCONSISTENT':
      return 'UNSUPPORTED_PROVIDER_STATE';
    case 'ATTEMPT_TERMINAL_RECONCILIATION_REQUIRED':
      return 'UNSUPPORTED_PROVIDER_STATE';
    case 'IDEMPOTENCY_CONFLICT':
      return 'CONFLICT_IDEMPOTENCY';
    case 'UNKNOWN':
      return 'UNKNOWN';
  }
}

/**
 * Erreur métier typée pour l'initiation de paiement.
 *
 * Contrairement à PaymentProviderError, PaymentInitiationError porte un
 * `statusCode` et un `responseBody` stable afin d'être persistée dans
 * idempotency_records via `failKey` et rejouée exactement lors d'un replay.
 *
 * Le `clientSecret` ne doit JAMAIS apparaître dans le message, le responseBody
 * ou les fieldErrors.
 */
export class PaymentInitiationError extends Error {
  readonly code: PaymentInitiationErrorCode;
  readonly statusCode: number;
  readonly responseBody: { error: string; message: string };
  readonly fieldErrors?: FieldErrors | undefined;

  constructor(
    code: PaymentInitiationErrorCode,
    message: string,
    options?: {
      statusCode?: number;
      responseBody?: { error: string; message: string };
      fieldErrors?: FieldErrors;
    },
  ) {
    super(message);
    this.name = 'PaymentInitiationError';
    this.code = code;
    this.statusCode = options?.statusCode ?? 400;
    this.responseBody = options?.responseBody ?? {
      error: toActionErrorCode(code),
      message,
    };
    this.fieldErrors = options?.fieldErrors;
  }
}
