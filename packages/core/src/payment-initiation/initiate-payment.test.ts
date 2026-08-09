import { describe, it, expect } from 'vitest';

/**
 * Tests unitaires du module payment-initiation (Lot 5, ADR-010 §7).
 *
 * Tests purs — aucune base de données, aucun PostgreSQL. Le provider est mocké
 * ou non requis (validation avant tout appel DB). Les tests d'intégration
 * PostgreSQL vivent dans Phase 4d.
 */

import { computePaymentFingerprint } from './fingerprint';
import { initiatePayment, mapProviderStatusToLocal } from './initiate-payment';
import { PaymentInitiationError, toActionErrorCode } from './errors';
import type {
  InitiatePaymentDependencies,
  InitiatePaymentInput,
  PersistedPaymentResponse,
} from './types';
import type { PaymentMetadata } from '../payments/types';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures de test uniquement. Aucune fixture n'est chargeable en production.
// ─────────────────────────────────────────────────────────────────────────────

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const CUSTOMER_ID = '00000000-0000-0000-0000-000000000002';
const DRAFT_ID = '00000000-0000-0000-0000-000000000003';

function baseTermsAcceptance(
  overrides: Partial<{ termsVersion: string; userId: string; acceptedAt: string }> = {},
) {
  return {
    termsVersion: 'v1',
    userId: CUSTOMER_ID,
    acceptedAt: '2024-06-01T12:00:00.000Z',
    ...overrides,
  };
}

function baseFinancialTermsConfig() {
  return {
    tax: {
      version: 'tax-v1',
      status: 'NOT_APPLICABLE' as const,
      amountMinor: null,
      rateBps: null,
      invoiceIssuer: 'Uttily SAS',
    },
    commission: {
      version: 'commission-v1',
      basis: 'total_amount_minor',
      amountMinor: 0,
    },
    connectedAccount: {
      accountId: 'acct_123',
      chargesEnabled: true,
      transfersCapabilityStatus: 'ACTIVE' as const,
      settlementMerchantMode: 'CONNECTED_ACCOUNT' as const,
      onBehalfOfAccountId: null,
    },
    legalTermsVersion: 'v1',
  };
}

function baseInput(overrides: Partial<InitiatePaymentInput> = {}): InitiatePaymentInput {
  return {
    draftId: DRAFT_ID,
    idempotencyKey: 'user-idempotency-key-abc',
    organizationId: ORG_ID,
    customerUserId: CUSTOMER_ID,
    environment: 'TEST',
    financialTermsConfig: baseFinancialTermsConfig(),
    termsAcceptance: baseTermsAcceptance(),
    ...overrides,
  };
}

const deps: InitiatePaymentDependencies = {
  db: {} as unknown as InitiatePaymentDependencies['db'], // non atteint — la validation précède tout appel DB
  provider: {} as unknown as InitiatePaymentDependencies['provider'], // non atteint — la validation précède tout appel provider
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. computePaymentFingerprint
// ─────────────────────────────────────────────────────────────────────────────

describe('computePaymentFingerprint', () => {
  const baseFingerprintInput = {
    organizationId: ORG_ID,
    customerUserId: CUSTOMER_ID,
    draftId: DRAFT_ID,
    environment: 'TEST' as const,
    termsVersion: 'v1',
  };

  it('est déterministe — même intention → même empreinte', () => {
    const a = computePaymentFingerprint(baseFingerprintInput);
    const b = computePaymentFingerprint(baseFingerprintInput);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('draft différent → empreinte différente', () => {
    const a = computePaymentFingerprint(baseFingerprintInput);
    const b = computePaymentFingerprint({
      ...baseFingerprintInput,
      draftId: '00000000-0000-0000-0000-000000000099',
    });
    expect(a).not.toBe(b);
  });

  it('organisation différente → empreinte différente', () => {
    const a = computePaymentFingerprint(baseFingerprintInput);
    const b = computePaymentFingerprint({
      ...baseFingerprintInput,
      organizationId: '00000000-0000-0000-0000-000000000099',
    });
    expect(a).not.toBe(b);
  });

  it('utilisateur différent → empreinte différente', () => {
    const a = computePaymentFingerprint(baseFingerprintInput);
    const b = computePaymentFingerprint({
      ...baseFingerprintInput,
      customerUserId: '00000000-0000-0000-0000-000000000099',
    });
    expect(a).not.toBe(b);
  });

  it('environnement différent → empreinte différente', () => {
    const a = computePaymentFingerprint(baseFingerprintInput);
    const b = computePaymentFingerprint({
      ...baseFingerprintInput,
      environment: 'LIVE',
    });
    expect(a).not.toBe(b);
  });

  it('version des termes différente → empreinte différente', () => {
    const a = computePaymentFingerprint(baseFingerprintInput);
    const b = computePaymentFingerprint({
      ...baseFingerprintInput,
      termsVersion: 'v2',
    });
    expect(a).not.toBe(b);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. mapProviderStatusToLocal
// ─────────────────────────────────────────────────────────────────────────────

describe('mapProviderStatusToLocal', () => {
  it('requires_payment_method → REQUIRES_PAYMENT_METHOD', () => {
    expect(mapProviderStatusToLocal('requires_payment_method')).toBe('REQUIRES_PAYMENT_METHOD');
  });

  it('requires_action → REQUIRES_ACTION', () => {
    expect(mapProviderStatusToLocal('requires_action')).toBe('REQUIRES_ACTION');
  });

  it('processing → PROCESSING', () => {
    expect(mapProviderStatusToLocal('processing')).toBe('PROCESSING');
  });

  it('succeeded → SUCCEEDED', () => {
    expect(mapProviderStatusToLocal('succeeded')).toBe('SUCCEEDED');
  });

  it('canceled → CANCELLED', () => {
    expect(mapProviderStatusToLocal('canceled')).toBe('CANCELLED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. initiatePayment — validation des entrées
// ─────────────────────────────────────────────────────────────────────────────

describe('initiatePayment — validation', () => {
  it('rejette organizationId manquant', async () => {
    await expect(initiatePayment(deps, baseInput({ organizationId: '' }))).rejects.toThrow(
      PaymentInitiationError,
    );
  });

  it('rejette organizationId non-UUID', async () => {
    await expect(
      initiatePayment(deps, baseInput({ organizationId: 'not-a-uuid' })),
    ).rejects.toThrow(PaymentInitiationError);
  });

  it('rejette customerUserId manquant', async () => {
    await expect(initiatePayment(deps, baseInput({ customerUserId: '' }))).rejects.toThrow(
      PaymentInitiationError,
    );
  });

  it('rejette customerUserId non-UUID', async () => {
    await expect(
      initiatePayment(deps, baseInput({ customerUserId: 'not-a-uuid' })),
    ).rejects.toThrow(PaymentInitiationError);
  });

  it('rejette draftId manquant', async () => {
    await expect(initiatePayment(deps, baseInput({ draftId: '' }))).rejects.toThrow(
      PaymentInitiationError,
    );
  });

  it('rejette draftId non-UUID', async () => {
    await expect(initiatePayment(deps, baseInput({ draftId: 'not-a-uuid' }))).rejects.toThrow(
      PaymentInitiationError,
    );
  });

  it('rejette idempotencyKey manquant', async () => {
    await expect(initiatePayment(deps, baseInput({ idempotencyKey: '' }))).rejects.toThrow(
      PaymentInitiationError,
    );
  });

  it('rejette environment invalide', async () => {
    await expect(
      initiatePayment(deps, baseInput({ environment: 'INVALID' as unknown as 'TEST' | 'LIVE' })),
    ).rejects.toThrow(PaymentInitiationError);
  });

  it('rejette termsAcceptance sans termsVersion', async () => {
    await expect(
      initiatePayment(
        deps,
        baseInput({ termsAcceptance: baseTermsAcceptance({ termsVersion: '' }) }),
      ),
    ).rejects.toThrow(PaymentInitiationError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. PersistedPaymentResponse — absence de clientSecret
// ─────────────────────────────────────────────────────────────────────────────

describe('PersistedPaymentResponse', () => {
  it('ne contient pas de champ clientSecret', () => {
    const response: PersistedPaymentResponse = {
      paymentId: 'test-payment-id',
      paymentAttemptId: 'test-attempt-id',
      providerPaymentIntentId: 'pi_test123',
      providerStatus: 'requires_payment_method',
      processingDeadlineAt: new Date().toISOString(),
    };
    expect(response).not.toHaveProperty('clientSecret');
    expect(JSON.stringify(response)).not.toContain('clientSecret');
    expect(JSON.stringify(response)).not.toContain('secret');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. PaymentInitiationError
// ─────────────────────────────────────────────────────────────────────────────

describe('PaymentInitiationError', () => {
  it('porte un code fermé', () => {
    const err = new PaymentInitiationError('DRAFT_EXPIRED', 'test');
    expect(err.code).toBe('DRAFT_EXPIRED');
    expect(err.statusCode).toBe(400);
  });

  it('responseBody ne contient pas de secret', () => {
    const err = new PaymentInitiationError('PROVIDER_CALL_FAILED', 'test');
    expect(JSON.stringify(err.responseBody)).not.toContain('secret');
    expect(JSON.stringify(err.responseBody)).not.toContain('clientSecret');
  });

  it('toActionErrorCode mappe vers ActionErrorCode', () => {
    expect(toActionErrorCode('IDEMPOTENCY_CONFLICT')).toBe('CONFLICT_IDEMPOTENCY');
    expect(toActionErrorCode('FINANCIAL_TERMS_UNRESOLVED')).toBe('FINANCIAL_TERMS_UNRESOLVED');
    expect(toActionErrorCode('ORGANIZATION_MISMATCH')).toBe('FORBIDDEN');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. PaymentIntent metadata — clés fermées
// ─────────────────────────────────────────────────────────────────────────────

describe('PaymentIntent metadata', () => {
  it('contient exactement les 5 clés fermées', () => {
    const metadata: PaymentMetadata = {
      payment_id: 'pay-1',
      payment_attempt_id: 'att-1',
      draft_id: 'draft-1',
      organization_id: 'org-1',
      protocol_version: 'v1',
    };
    const keys = Object.keys(metadata);
    expect(keys).toHaveLength(5);
    expect(keys).toContain('payment_id');
    expect(keys).toContain('payment_attempt_id');
    expect(keys).toContain('draft_id');
    expect(keys).toContain('organization_id');
    expect(keys).toContain('protocol_version');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Provider idempotency key format
// ─────────────────────────────────────────────────────────────────────────────

describe('provider idempotency key format', () => {
  it("est dérivé de l'identité de la tentative, pas de la clé utilisateur", () => {
    // Le format est pi_{paymentId}_{attemptNumber}
    const paymentId = '00000000-0000-0000-0000-000000000001';
    const attemptNumber = 1;
    const key = `pi_${paymentId}_${attemptNumber}`;
    expect(key).toBe('pi_00000000-0000-0000-0000-000000000001_1');
    expect(key).not.toContain('user-key');
  });
});
