import { PaymentProviderError } from './errors';
import type { PaymentMetadata } from './types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INITIAL_KEYS = [
  'payment_id',
  'payment_attempt_id',
  'draft_id',
  'organization_id',
  'protocol_version',
] as const;
const AMENDMENT_KEYS = [
  'payment_type',
  'amendment_payment_attempt_id',
  'amendment_id',
  'organization_id',
  'environment',
  'protocol_version',
] as const;

function invalidMetadata(): never {
  throw new PaymentProviderError('VALIDATION', 'Metadata de paiement invalide', 'invalid_metadata');
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

/**
 * Validation runtime unique des metadata PaymentIntent.
 * Le même contrat est appelé par FakeStripeAdapter et StripeAdapter.
 */
export function validatePaymentMetadata(metadata: PaymentMetadata): void {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    invalidMetadata();
  }

  const value = metadata as unknown as Record<string, unknown>;
  if (value.payment_type !== undefined) {
    if (
      !hasExactKeys(value, AMENDMENT_KEYS) ||
      value.payment_type !== 'AMENDMENT' ||
      !isUuid(value.amendment_payment_attempt_id) ||
      !isUuid(value.amendment_id) ||
      !isUuid(value.organization_id) ||
      (value.environment !== 'TEST' && value.environment !== 'LIVE') ||
      value.protocol_version !== 'booking-amendment-payment-v1'
    ) {
      invalidMetadata();
    }
    return;
  }

  if (
    !hasExactKeys(value, INITIAL_KEYS) ||
    !INITIAL_KEYS.every((key) => isNonEmptyString(value[key]))
  ) {
    invalidMetadata();
  }
}
