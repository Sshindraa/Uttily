/**
 * Tests unitaires du read model getConnectedAccountReadiness
 * (Lot 5, ADR-010 §3.3, §16 étape 4).
 *
 * Tests purs — aucune base de données, aucun PostgreSQL. La DB est mockée via
 * un faux store en mémoire.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getConnectedAccountReadiness } from './get-connected-account-readiness';
import type { ConnectedAccountDependencies } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures de test uniquement. Aucune fixture n'est chargeable en production.
// ─────────────────────────────────────────────────────────────────────────────

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const ROW_ID = '00000000-0000-0000-0000-000000000010';
const PROVIDER_ACCOUNT_ID = 'acct_test_123';

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

function makeMockDb(accountRow: AccountRow | null) {
  const selectMock = vi.fn().mockImplementation(() => ({
    from: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation(() => ({
        limit: vi.fn().mockResolvedValue(accountRow ? [accountRow] : []),
      })),
    })),
  }));

  return {
    select: selectMock,
  } as unknown as import('@uttily/database').DatabaseClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('getConnectedAccountReadiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ready = true quand chargesEnabled ET transfers ACTIVE', async () => {
    const accountRow = baseAccountRow({
      chargesEnabled: true,
      transfersCapabilityStatus: 'ACTIVE',
      onboardingStatus: 'ENABLED',
    });
    const db = makeMockDb(accountRow);
    const deps: Pick<ConnectedAccountDependencies, 'db'> = { db };

    const result = await getConnectedAccountReadiness(deps, ORG_ID, 'TEST');

    expect(result.notConfigured).toBe(false);
    expect(result.ready).toBe(true);
    expect(result.chargesEnabled).toBe(true);
    expect(result.transfersCapabilityStatus).toBe('ACTIVE');
    expect(result.organizationPaymentAccountId).toBe(ROW_ID);
    expect(result.providerAccountId).toBe(PROVIDER_ACCOUNT_ID);
    expect(result.onboardingStatus).toBe('ENABLED');
  });

  it('ready = false quand chargesEnabled = false', async () => {
    const accountRow = baseAccountRow({
      chargesEnabled: false,
      transfersCapabilityStatus: 'ACTIVE',
    });
    const db = makeMockDb(accountRow);
    const deps: Pick<ConnectedAccountDependencies, 'db'> = { db };

    const result = await getConnectedAccountReadiness(deps, ORG_ID, 'TEST');

    expect(result.notConfigured).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.chargesEnabled).toBe(false);
  });

  it('notConfigured = true quand aucun compte trouvé', async () => {
    const db = makeMockDb(null);
    const deps: Pick<ConnectedAccountDependencies, 'db'> = { db };

    const result = await getConnectedAccountReadiness(deps, ORG_ID, 'TEST');

    expect(result.notConfigured).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.organizationPaymentAccountId).toBeNull();
    expect(result.providerAccountId).toBeNull();
    expect(result.onboardingStatus).toBeNull();
    expect(result.transfersCapabilityStatus).toBeNull();
    expect(result.chargesEnabled).toBe(false);
    expect(result.payoutsEnabled).toBe(false);
  });

  it('ready = false quand transfersCapabilityStatus = INACTIVE', async () => {
    const accountRow = baseAccountRow({
      chargesEnabled: true,
      transfersCapabilityStatus: 'INACTIVE',
    });
    const db = makeMockDb(accountRow);
    const deps: Pick<ConnectedAccountDependencies, 'db'> = { db };

    const result = await getConnectedAccountReadiness(deps, ORG_ID, 'TEST');

    expect(result.notConfigured).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.transfersCapabilityStatus).toBe('INACTIVE');
  });

  it('ready = false quand transfersCapabilityStatus = PENDING', async () => {
    const accountRow = baseAccountRow({
      chargesEnabled: true,
      transfersCapabilityStatus: 'PENDING',
    });
    const db = makeMockDb(accountRow);
    const deps: Pick<ConnectedAccountDependencies, 'db'> = { db };

    const result = await getConnectedAccountReadiness(deps, ORG_ID, 'TEST');

    expect(result.ready).toBe(false);
    expect(result.transfersCapabilityStatus).toBe('PENDING');
  });

  it('rejette organizationId non-UUID', async () => {
    const db = makeMockDb(null);
    const deps: Pick<ConnectedAccountDependencies, 'db'> = { db };

    await expect(getConnectedAccountReadiness(deps, 'not-a-uuid', 'TEST')).rejects.toThrow(
      'organizationId doit être un UUID valide',
    );
  });

  it('rejette environment invalide', async () => {
    const db = makeMockDb(null);
    const deps: Pick<ConnectedAccountDependencies, 'db'> = { db };

    await expect(
      getConnectedAccountReadiness(deps, ORG_ID, 'PROD' as unknown as 'TEST' | 'LIVE'),
    ).rejects.toThrow('Environnement invalide');
  });

  it('retourne environment depuis la ligne DB', async () => {
    const accountRow = baseAccountRow({ environment: 'TEST' });
    const db = makeMockDb(accountRow);
    const deps: Pick<ConnectedAccountDependencies, 'db'> = { db };

    const result = await getConnectedAccountReadiness(deps, ORG_ID, 'TEST');

    expect(result.environment).toBe('TEST');
  });
});
