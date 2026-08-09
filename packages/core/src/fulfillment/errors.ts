import type { BookingTransitionErrorCode, BookingStatus } from './types';

/**
 * Erreur métier typée pour une transition de booking interdite.
 */
export class BookingTransitionError extends Error {
  readonly code: BookingTransitionErrorCode;
  readonly fromStatus: BookingStatus;
  readonly toStatus: BookingStatus;

  constructor(
    code: BookingTransitionErrorCode,
    fromStatus: BookingStatus,
    toStatus: BookingStatus,
    message: string,
  ) {
    super(message);
    this.name = 'BookingTransitionError';
    this.code = code;
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}
