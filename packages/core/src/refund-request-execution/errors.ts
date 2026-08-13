/** Codes fermés du moteur REFUND_REQUESTED.v1. */
export type RefundRequestErrorCode =
  | 'PAYLOAD_MALFORMED'
  | 'LEASE_LOST'
  | 'OUTBOX_METADATA_MISMATCH'
  | 'REFUND_NOT_FOUND'
  | 'REFUND_ALREADY_RESOLVED'
  | 'REFUND_STATUS_INVALID'
  | 'REFUND_REASON_MISMATCH'
  | 'REFUND_ORGANIZATION_MISMATCH'
  | 'REFUND_PAYMENT_ORIGIN_INVALID'
  | 'PAYMENT_NOT_FOUND'
  | 'PAYMENT_NOT_SUCCEEDED'
  | 'PAYMENT_ORGANIZATION_MISMATCH'
  | 'PAYMENT_CURRENCY_MISMATCH'
  | 'AMOUNT_INVALID'
  | 'REFUND_FLAGS_INVALID'
  | 'IDEMPOTENCY_KEY_MISMATCH'
  | 'AMENDMENT_NOT_FOUND'
  | 'AMENDMENT_MISMATCH'
  | 'ATTEMPT_NOT_SUCCEEDED'
  | 'ENVIRONMENT_MISMATCH'
  | 'PROVIDER_RESULT_INVALID'
  | 'PROVIDER_REFUND_ID_CONFLICT';

export class RefundRequestError extends Error {
  readonly code: RefundRequestErrorCode;

  constructor(code: RefundRequestErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'RefundRequestError';
    this.code = code;
  }
}
