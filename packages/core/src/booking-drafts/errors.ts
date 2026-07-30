import type { ActionErrorCode, FieldErrors } from '@uttily/contracts';
import type { BookingDraftFailureBody } from './types';

/**
 * Erreur métier typée pour la création d'un brouillon de réservation.
 *
 * Contrairement à IdempotencyError, BookingDraftError porte un `statusCode`
 * et un `responseBody` stable afin d'être persistée dans idempotency_records
 * via `failKey` et rejouée exactement lors d'un replay.
 */
export class BookingDraftError extends Error {
  readonly code: ActionErrorCode;
  readonly statusCode: 400 | 404 | 409;
  readonly responseBody: BookingDraftFailureBody;
  readonly fieldErrors?: FieldErrors | undefined;

  constructor(
    code: ActionErrorCode,
    message: string,
    options?: {
      statusCode?: 400 | 404 | 409;
      responseBody?: BookingDraftFailureBody;
      fieldErrors?: FieldErrors;
    },
  ) {
    super(message);
    this.name = 'BookingDraftError';
    this.code = code;
    this.statusCode = options?.statusCode ?? 400;
    this.responseBody = options?.responseBody ?? { error: code, message };
    this.fieldErrors = options?.fieldErrors;
  }
}
