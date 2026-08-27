import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAccountSession } from './create-account-session';
import type { ConnectedAccountDependencies, CreateAccountSessionInput } from './types';
import type { AccountSessionResult, PaymentProviderAdapter } from '../payments/types';

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const PROVIDER_ACCOUNT_ID = 'acct_test_123';
const ROW_ID = '00000000-0000-0000-0000-000000000010';

interface AccountRow {
  id: string;
  organizationId: string;
  provider: 'STRIPE';
  environment: 'TEST' | 'LIVE';
  providerAccountId: string;
}

function baseAccountRow(): AccountRow {
  return {
    id: ROW_ID,
    organizationId: ORG_ID,
    provider: 'STRIPE',
    environment: 'TEST',
    providerAccountId: PROVIDER_ACCOUNT_ID,
  };
}

describe('createAccountSession use case', () => {
  let mockStore: AccountRow[];
  let mockProvider: PaymentProviderAdapter;
  let deps: ConnectedAccountDependencies;

  beforeEach(() => {
    mockStore = [baseAccountRow()];

    mockProvider = {
      environment: 'TEST',
      createPaymentIntent: vi.fn(),
      retrievePaymentIntent: vi.fn(),
      cancelPaymentIntent: vi.fn(),
      createRefund: vi.fn(),
      retrieveRefund: vi.fn(),
      verifyWebhook: vi.fn(),
      createConnectedAccount: vi.fn(),
      retrieveConnectedAccount: vi.fn(),
      createOnboardingLink: vi.fn(),
      createAccountSession: vi.fn().mockResolvedValue({
        clientSecret: 'account_session_secret_123',
        expiresAt: 1800000000,
      } satisfies AccountSessionResult),
      projectCapabilities: vi.fn(),
    };

    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(mockStore),
          }),
        }),
      }),
    };

    deps = {
      db: fakeDb as unknown as ConnectedAccountDependencies['db'],
      provider: mockProvider,
    };
  });

  it('génère une Account Session pour un compte connecté existant', async () => {
    const input: CreateAccountSessionInput = {
      organizationId: ORG_ID,
      environment: 'TEST',
    };

    const result = await createAccountSession(deps, input);

    expect(mockProvider.createAccountSession).toHaveBeenCalledWith({
      accountId: PROVIDER_ACCOUNT_ID,
    });
    expect(result.clientSecret).toBe('account_session_secret_123');
    expect(result.expiresAt).toBe(1800000000);
  });

  it('rejette si l’organisation n’a aucun compte connecté', async () => {
    mockStore = [];
    const input: CreateAccountSessionInput = {
      organizationId: ORG_ID,
      environment: 'TEST',
    };

    await expect(createAccountSession(deps, input)).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
    });
  });

  it('rejette si l’ID d’organisation est invalide', async () => {
    const input: CreateAccountSessionInput = {
      organizationId: 'not-a-uuid',
      environment: 'TEST',
    };

    await expect(createAccountSession(deps, input)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });
});
