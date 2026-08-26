/**
 * Tests unitaires du use case createConnectedAccount
 * (Lot 5, ADR-010 §3.3, §16 étape 4).
 *
 * Tests purs — aucune base de données, aucun PostgreSQL. Le provider est mocké
 * via `vi.fn()`. La DB est mockée via un faux store en mémoire.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaymentProviderError } from '../payments/errors';
import { createConnectedAccount } from './create-connected-account';
import { toActionErrorCode } from './errors';
import { DEFAULT_CONTROLLER_CONFIG } from './types';
import type { ConnectedAccountDependencies, CreateConnectedAccountInput } from './types';
import type { ConnectedAccountResult, PaymentProviderAdapter } from '../payments/types';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures de test uniquement. Aucune fixture n'est chargeable en production.
// ─────────────────────────────────────────────────────────────────────────────

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const PROVIDER_ACCOUNT_ID = 'acct_test_123';

function baseInput(
  overrides: Partial<CreateConnectedAccountInput> = {},
): CreateConnectedAccountInput {
  return {
    organizationId: ORG_ID,
    environment: 'TEST',
    country: 'FR',
    idempotencyKey: 'onboarding-key-abc',
    ...overrides,
  };
}

function makeProviderResult(
  overrides: Partial<ConnectedAccountResult> = {},
): ConnectedAccountResult {
  return {
    id: PROVIDER_ACCOUNT_ID,
    chargesEnabled: false,
    payoutsEnabled: false,
    transfersCapabilityStatus: 'PENDING',
    onboardingStatus: 'PENDING',
    requirements: { currently_due: [] },
    controllerConfiguration: { ...DEFAULT_CONTROLLER_CONFIG },
    apiGeneration: 'ACCOUNTS_V1_CONTROLLER_PROPERTIES',
    ...overrides,
  };
}

interface MockDbState {
  existingAccounts: Array<{ id: string }>;
  inserted: Array<Record<string, unknown>>;
  insertShouldFail: boolean;
}

function makeMockDb(state: MockDbState) {
  const selectMock = vi.fn().mockImplementation(() => ({
    from: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation(() => ({
        limit: vi.fn().mockResolvedValue(state.existingAccounts),
      })),
    })),
  }));

  const insertMock = vi.fn().mockImplementation(() => {
    return {
      values: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        if (state.insertShouldFail) {
          throw new Error('DB insert failed');
        }
        const row = { id: 'row-001', ...values };
        state.inserted.push(row);
        return {
          returning: vi.fn().mockResolvedValue([{ id: 'row-001' }]),
        };
      }),
    };
  });

  return {
    select: selectMock,
    insert: insertMock,
  } as unknown as import('@uttily/database').DatabaseClient;
}

function makeMockProvider(
  result: ConnectedAccountResult = makeProviderResult(),
  shouldFail = false,
): PaymentProviderAdapter {
  const createConnectedAccountFn = vi.fn();
  if (shouldFail) {
    createConnectedAccountFn.mockRejectedValue(
      new PaymentProviderError('UNKNOWN', 'Stripe API error', 'api_error'),
    );
  } else {
    createConnectedAccountFn.mockResolvedValue(result);
  }
  return {
    environment: 'TEST',
    createConnectedAccount: createConnectedAccountFn,
  } as unknown as PaymentProviderAdapter;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('createConnectedAccount', () => {
  let state: MockDbState;

  beforeEach(() => {
    state = { existingAccounts: [], inserted: [], insertShouldFail: false };
  });

  it('crée un compte Stripe et insère la ligne DB (nominal)', async () => {
    const db = makeMockDb(state);
    const provider = makeMockProvider();
    const deps: ConnectedAccountDependencies = { db, provider };

    const result = await createConnectedAccount(deps, baseInput());

    expect(result.providerAccountId).toBe(PROVIDER_ACCOUNT_ID);
    expect(result.onboardingStatus).toBe('PENDING');
    expect(result.chargesEnabled).toBe(false);
    expect(result.payoutsEnabled).toBe(false);
    expect(result.organizationPaymentAccountId).toBe('row-001');
    expect(provider.createConnectedAccount).toHaveBeenCalledOnce();
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]!.providerAccountId).toBe(PROVIDER_ACCOUNT_ID);
    expect(state.inserted[0]!.onboardingStatus).toBe('PENDING');
    expect(state.inserted[0]!.settlementMerchantMode).toBe('PLATFORM');
    expect(state.inserted[0]!.accountApiGeneration).toBe('ACCOUNTS_V1_CONTROLLER_PROPERTIES');
    expect(state.inserted[0]!.transfersCapabilityStatus).toBe('PENDING');
  });

  it('lève ACCOUNT_ALREADY_EXISTS si un compte existe déjà', async () => {
    state.existingAccounts = [{ id: 'existing-row' }];
    const db = makeMockDb(state);
    const provider = makeMockProvider();
    const deps: ConnectedAccountDependencies = { db, provider };

    await expect(createConnectedAccount(deps, baseInput())).rejects.toMatchObject({
      code: 'ACCOUNT_ALREADY_EXISTS',
    });
    expect(provider.createConnectedAccount).not.toHaveBeenCalled();
  });

  it("propage l'erreur provider (PROVIDER_CALL_FAILED)", async () => {
    const db = makeMockDb(state);
    const provider = makeMockProvider(makeProviderResult(), true);
    const deps: ConnectedAccountDependencies = { db, provider };

    await expect(createConnectedAccount(deps, baseInput())).rejects.toMatchObject({
      code: 'PROVIDER_CALL_FAILED',
    });
  });

  it('rejette un controller config invalide (VALIDATION)', async () => {
    const db = makeMockDb(state);
    const provider = makeMockProvider();
    const deps: ConnectedAccountDependencies = { db, provider };

    // requirementCollection=PLATFORM est incompatible avec lossesCollector=STRIPE
    await expect(
      createConnectedAccount(
        deps,
        baseInput({
          controller: {
            feesPayer: 'PLATFORM',
            lossesCollector: 'STRIPE',
            stripeDashboard: 'NONE',
            requirementCollection: 'PLATFORM',
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(provider.createConnectedAccount).not.toHaveBeenCalled();
  });

  it('idempotence : même idempotencyKey → provider gère le replay', async () => {
    const db = makeMockDb(state);
    const providerResult = makeProviderResult();
    const createFn = vi.fn().mockResolvedValue(providerResult);
    const provider = {
      environment: 'TEST',
      createConnectedAccount: createFn,
    } as unknown as PaymentProviderAdapter;
    const deps: ConnectedAccountDependencies = { db, provider };

    // Premier appel — DB vide, provider crée le compte.
    // (On reset l'état entre les deux appels car la DB mock est stateful.)
    const r1 = await createConnectedAccount(deps, baseInput({ idempotencyKey: 'same-key' }));
    expect(r1.providerAccountId).toBe(PROVIDER_ACCOUNT_ID);

    // Deuxième appel avec même key — le provider (Stripe) gère l'idempotence
    // et retourne le même compte. Mais la DB locale a déjà une ligne → ACCOUNT_ALREADY_EXISTS.
    state.existingAccounts = [{ id: 'row-001' }];
    const db2 = makeMockDb(state);
    const deps2: ConnectedAccountDependencies = { db: db2, provider };
    await expect(
      createConnectedAccount(deps2, baseInput({ idempotencyKey: 'same-key' })),
    ).rejects.toMatchObject({ code: 'ACCOUNT_ALREADY_EXISTS' });
  });

  it('rejette organizationId non-UUID (VALIDATION)', async () => {
    const db = makeMockDb(state);
    const provider = makeMockProvider();
    const deps: ConnectedAccountDependencies = { db, provider };

    await expect(
      createConnectedAccount(deps, baseInput({ organizationId: 'not-a-uuid' })),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejette environment invalide (VALIDATION)', async () => {
    const db = makeMockDb(state);
    const provider = makeMockProvider();
    const deps: ConnectedAccountDependencies = { db, provider };

    await expect(
      createConnectedAccount(
        deps,
        baseInput({ environment: 'PROD' as unknown as 'TEST' | 'LIVE' }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejette country vide (VALIDATION)', async () => {
    const db = makeMockDb(state);
    const provider = makeMockProvider();
    const deps: ConnectedAccountDependencies = { db, provider };

    await expect(createConnectedAccount(deps, baseInput({ country: '' }))).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('utilise exactement le preset Express France sans controller explicite', async () => {
    const db = makeMockDb(state);
    const createFn = vi.fn().mockResolvedValue(makeProviderResult());
    const provider = {
      environment: 'TEST',
      createConnectedAccount: createFn,
    } as unknown as PaymentProviderAdapter;
    const deps: ConnectedAccountDependencies = { db, provider };

    await createConnectedAccount(deps, baseInput());

    expect(createFn).toHaveBeenCalledOnce();
    const calledParams = createFn.mock.calls[0]![0];
    expect(calledParams.controller).toEqual({
      feesPayer: 'PLATFORM',
      lossesCollector: 'PLATFORM',
      stripeDashboard: 'EXPRESS',
      requirementCollection: 'STRIPE',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toActionErrorCode — mapping
// ─────────────────────────────────────────────────────────────────────────────

describe('toActionErrorCode (connected-accounts)', () => {
  it('mappe ACCOUNT_ALREADY_EXISTS → CONFLICT_IDEMPOTENCY', () => {
    expect(toActionErrorCode('ACCOUNT_ALREADY_EXISTS')).toBe('CONFLICT_IDEMPOTENCY');
  });

  it('mappe ACCOUNT_NOT_FOUND → NOT_FOUND', () => {
    expect(toActionErrorCode('ACCOUNT_NOT_FOUND')).toBe('NOT_FOUND');
  });

  it('mappe ONBOARDING_NOT_STARTED → PAYMENT_ACCOUNT_NOT_READY', () => {
    expect(toActionErrorCode('ONBOARDING_NOT_STARTED')).toBe('PAYMENT_ACCOUNT_NOT_READY');
  });

  it('mappe ENVIRONMENT_MISMATCH → PAYMENT_ENVIRONMENT_MISMATCH', () => {
    expect(toActionErrorCode('ENVIRONMENT_MISMATCH')).toBe('PAYMENT_ENVIRONMENT_MISMATCH');
  });

  it('mappe PROVIDER_CALL_FAILED → UNKNOWN', () => {
    expect(toActionErrorCode('PROVIDER_CALL_FAILED')).toBe('UNKNOWN');
  });
});
