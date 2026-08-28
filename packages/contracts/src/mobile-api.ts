/**
 * Contrat indépendant du transport pour la future API mobile v1.
 *
 * Ce fichier ne dépend ni de Next.js, ni des Server Actions, ni du Web.
 * Il fixe uniquement la forme fermée des erreurs et la politique de reprise.
 */

export const MOBILE_API_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'HOLD_EXPIRED',
  'INSUFFICIENT_AVAILABILITY',
  'PAYMENT_ACTION_REQUIRED',
  'PAYMENT_PENDING',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;

export type MobileApiErrorCode = (typeof MOBILE_API_ERROR_CODES)[number];

export const MOBILE_RETRY_POLICIES = [
  'RETRY_SAFE',
  'RETRY_WITH_SAME_IDEMPOTENCY_KEY',
  'DO_NOT_RETRY',
  'REFRESH_STATE_BEFORE_RETRY',
] as const;

export type MobileRetryPolicy = (typeof MOBILE_RETRY_POLICIES)[number];

export type MobileApiRetryRule = Readonly<{
  retryable: boolean;
  policy: MobileRetryPolicy;
}>;

/** Mapping unique et testable entre une erreur publique et sa reprise. */
export const MOBILE_API_ERROR_RETRY = {
  UNAUTHENTICATED: { retryable: false, policy: 'DO_NOT_RETRY' },
  FORBIDDEN: { retryable: false, policy: 'DO_NOT_RETRY' },
  NOT_FOUND: { retryable: false, policy: 'DO_NOT_RETRY' },
  VALIDATION_ERROR: { retryable: false, policy: 'DO_NOT_RETRY' },
  CONFLICT: { retryable: false, policy: 'REFRESH_STATE_BEFORE_RETRY' },
  IDEMPOTENCY_CONFLICT: { retryable: false, policy: 'DO_NOT_RETRY' },
  HOLD_EXPIRED: { retryable: false, policy: 'REFRESH_STATE_BEFORE_RETRY' },
  INSUFFICIENT_AVAILABILITY: {
    retryable: false,
    policy: 'REFRESH_STATE_BEFORE_RETRY',
  },
  PAYMENT_ACTION_REQUIRED: { retryable: false, policy: 'DO_NOT_RETRY' },
  PAYMENT_PENDING: { retryable: true, policy: 'REFRESH_STATE_BEFORE_RETRY' },
  RATE_LIMITED: { retryable: true, policy: 'RETRY_SAFE' },
  INTERNAL_ERROR: {
    retryable: true,
    policy: 'RETRY_WITH_SAME_IDEMPOTENCY_KEY',
  },
} as const satisfies Record<MobileApiErrorCode, MobileApiRetryRule>;

export type MobileFieldErrors = Record<string, string[]>;

export type MobileApiError = {
  [Code in MobileApiErrorCode]: {
    code: Code;
    retryable: (typeof MOBILE_API_ERROR_RETRY)[Code]['retryable'];
    retryPolicy: (typeof MOBILE_API_ERROR_RETRY)[Code]['policy'];
    fieldErrors?: MobileFieldErrors;
  };
}[MobileApiErrorCode];

export type MobileApiSuccess<T> = {
  ok: true;
  data: T;
  requestId: string;
  /** Présent et vrai quand la réponse vient d’un résultat idempotent rejoué. */
  replayed?: boolean;
};

export type MobileApiFailure = {
  ok: false;
  error: MobileApiError;
  requestId: string;
  /** Présent et vrai quand l’erreur vient d’un résultat idempotent rejoué. */
  replayed?: boolean;
};

export type MobileApiResponse<T> = MobileApiSuccess<T> | MobileApiFailure;

export function isMobileApiErrorCode(value: unknown): value is MobileApiErrorCode {
  return typeof value === 'string' && (MOBILE_API_ERROR_CODES as readonly string[]).includes(value);
}

export function getMobileApiRetryRule(code: MobileApiErrorCode): MobileApiRetryRule {
  return MOBILE_API_ERROR_RETRY[code];
}
