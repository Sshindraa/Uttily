/**
 * Tests unitaires du use case createOnboardingLink
 * (Lot 5, ADR-010 §3.3, §16 étape 4).
 *
 * Tests purs — aucune base de données, aucun PostgreSQL. Le provider est mocké
 * via `vi.fn()`. La DB est mockée via un faux store en mémoire.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaymentProviderError } from '../payments/errors';
import { createOnboardingLink } from './create-onboarding-link';
import type { ConnectedAccountDependencies, CreateOnboardingLinkInput } from './types';
import type { OnboardingLinkResult, PaymentProviderAdapter } from '../payments/types';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures de test uniquement. Aucune fixture n'est chargeable en production.
// ─────────────────────────────────────────────────────────────────────────────

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const PROVIDER_ACCOUNT_ID = 'acct_test_123';
const ROW_ID = '00000000-0000-0000-0000-000000000010';

interface AccountRow {
  id: string;
  organizationId: string;
  provider: 'STRIPE';
  environment: 'TEST' | 'LIVE';
  providerAccountId: string;
  onboardingStatus: 'PENDING' | 'SUBMITTED' | 'ENABLED' | 'DISABLED' | 'REJECTED';
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  transfersCapabilityStatus: 'ACTIVE' | 'INACTIVE' | 'PENDING' | 'UNREQUESTED';
}

function baseAccountRow(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: ROW_ID,
    organizationId: ORG_ID,
    provider: 'STRIPE',
    environment: 'TEST',
    providerAccountId: PROVIDER_ACCOUNT_ID,
    onboardingStatus: 'PENDING',
    chargesEnabled: false,
    payoutsEnabled: false,
    transfersCapabilityStatus: 'PENDING',
    ...overrides,
  };
}

function baseInput(overrides: Partial<CreateOnboardingLinkInput> = {}): CreateOnboardingLinkInput {
  return {
    organizationId: ORG_ID,
    environment: 'TEST',
    returnUrl: 'https://app.uttily.test/onboarding/return',
    refreshUrl: 'https://app.uttily.test/onboarding/refresh',
    idempotencyKey: 'onboarding-link-key-abc',
    ...overrides,
  };
}

function makeOnboardingLinkResult(
  overrides: Partial<OnboardingLinkResult> = {},
): OnboardingLinkResult {
  return {
    url: 'https://connect.stripe.com/setup/c/abc123',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

function makeMockDb(accountRow: AccountRow | null) {
  const selectMock = vi.fn().mockImplementation(() => ({
    from: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation(() => ({
        limit: vi.fn().mockResolvedValue(accountRow ? [accountRow] : []),
      })),
    })),
  }));

  const updateMock = vi.fn().mockImplementation(() => ({
    set: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
  }));

  return {
    select: selectMock,
    update: updateMock,
  } as unknown as import('@uttily/database').DatabaseClient;
}

function makeMockProvider(
  result: OnboardingLinkResult = makeOnboardingLinkResult(),
  shouldFail = false,
): PaymentProviderAdapter {
  const createOnboardingLinkFn = vi.fn();
  if (shouldFail) {
    createOnboardingLinkFn.mockRejectedValue(
      new PaymentProviderError('UNKNOWN', 'Stripe API error', 'api_error'),
    );
  } else {
    createOnboardingLinkFn.mockResolvedValue(result);
  }
  return {
    environment: 'TEST',
    createOnboardingLink: createOnboardingLinkFn,
  } as unknown as PaymentProviderAdapter;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('createOnboardingLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('génère un lien et passe le statut à SUBMITTED (nominal)', async () => {
    const accountRow = baseAccountRow({ onboardingStatus: 'PENDING' });
    const db = makeMockDb(accountRow);
    const linkResult = makeOnboardingLinkResult();
    const provider = makeMockProvider(linkResult);
    const deps: ConnectedAccountDependencies = { db, provider };

    const result = await createOnboardingLink(deps, baseInput());

    expect(result.url).toBe(linkResult.url);
    expect(result.expiresAt).toBe(linkResult.expiresAt);
    expect(provider.createOnboardingLink).toHaveBeenCalledOnce();
    const calledParams = (provider.createOnboardingLink as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(calledParams.accountId).toBe(PROVIDER_ACCOUNT_ID);
    expect(calledParams.returnUrl).toBe(baseInput().returnUrl);
    expect(calledParams.refreshUrl).toBe(baseInput().refreshUrl);
    expect(calledParams.idempotencyKey).toBe(baseInput().idempotencyKey);
    // Vérifie que update a été appelé pour passer à SUBMITTED.
    expect(db.update).toHaveBeenCalled();
  });

  it('lève ACCOUNT_NOT_FOUND si le compte est introuvable', async () => {
    const db = makeMockDb(null);
    const provider = makeMockProvider();
    const deps: ConnectedAccountDependencies = { db, provider };

    await expect(createOnboardingLink(deps, baseInput())).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
    });
    expect(provider.createOnboardingLink).not.toHaveBeenCalled();
  });

  it('lève VALIDATION si le compte est déjà ENABLED', async () => {
    const accountRow = baseAccountRow({ onboardingStatus: 'ENABLED' });
    const db = makeMockDb(accountRow);
    const provider = makeMockProvider();
    const deps: ConnectedAccountDependencies = { db, provider };

    await expect(createOnboardingLink(deps, baseInput())).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    expect(provider.createOnboardingLink).not.toHaveBeenCalled();
  });

  it("propage l'erreur provider (PROVIDER_CALL_FAILED)", async () => {
    const accountRow = baseAccountRow({ onboardingStatus: 'PENDING' });
    const db = makeMockDb(accountRow);
    const provider = makeMockProvider(makeOnboardingLinkResult(), true);
    const deps: ConnectedAccountDependencies = { db, provider };

    await expect(createOnboardingLink(deps, baseInput())).rejects.toMatchObject({
      code: 'PROVIDER_CALL_FAILED',
    });
  });

  it('rejette organizationId non-UUID (VALIDATION)', async () => {
    const db = makeMockDb(baseAccountRow());
    const provider = makeMockProvider();
    const deps: ConnectedAccountDependencies = { db, provider };

    await expect(
      createOnboardingLink(deps, baseInput({ organizationId: 'not-a-uuid' })),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejette returnUrl vide (VALIDATION)', async () => {
    const db = makeMockDb(baseAccountRow());
    const provider = makeMockProvider();
    const deps: ConnectedAccountDependencies = { db, provider };

    await expect(createOnboardingLink(deps, baseInput({ returnUrl: '' }))).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('rejette refreshUrl vide (VALIDATION)', async () => {
    const db = makeMockDb(baseAccountRow());
    const provider = makeMockProvider();
    const deps: ConnectedAccountDependencies = { db, provider };

    await expect(createOnboardingLink(deps, baseInput({ refreshUrl: '' }))).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('autorise la régénération si le statut est SUBMITTED', async () => {
    const accountRow = baseAccountRow({ onboardingStatus: 'SUBMITTED' });
    const db = makeMockDb(accountRow);
    const provider = makeMockProvider();
    const deps: ConnectedAccountDependencies = { db, provider };

    const result = await createOnboardingLink(deps, baseInput());
    expect(result.url).toBeDefined();
    expect(provider.createOnboardingLink).toHaveBeenCalledOnce();
  });
});
