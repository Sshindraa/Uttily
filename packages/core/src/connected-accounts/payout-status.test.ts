import { describe, it, expect } from 'vitest';
import { resolvePayoutAccountStatus, type PayoutAccountStatus } from './payout-status';
import type { ConnectedAccountReadiness } from './types';

describe('PayoutStatus Read Model (Core Unit Tests)', () => {
  it('traduit un compte non configuré en NOT_STARTED', () => {
    const readiness: ConnectedAccountReadiness = {
      organizationPaymentAccountId: null,
      providerAccountId: null,
      environment: 'TEST',
      onboardingStatus: null,
      chargesEnabled: false,
      payoutsEnabled: false,
      transfersCapabilityStatus: null,
      ready: false,
      notConfigured: true,
    };

    const status: PayoutAccountStatus = resolvePayoutAccountStatus(readiness);

    expect(status.readiness).toBe('NOT_STARTED');
    expect(status.isReady).toBe(false);
    expect(status.label).toBe('Versements non configurés');
    expect(status.actionLabel).toBe('Activer mes versements');
  });

  it('traduit un onboarding en cours en ACTION_REQUIRED', () => {
    const readiness: ConnectedAccountReadiness = {
      organizationPaymentAccountId: 'acc-1',
      providerAccountId: 'acct_123',
      environment: 'TEST',
      onboardingStatus: 'PENDING',
      chargesEnabled: false,
      payoutsEnabled: false,
      transfersCapabilityStatus: 'INACTIVE',
      ready: false,
      notConfigured: false,
    };

    const status = resolvePayoutAccountStatus(readiness);

    expect(status.readiness).toBe('ACTION_REQUIRED');
    expect(status.isReady).toBe(false);
    expect(status.label).toBe('Informations requises');
    expect(status.actionLabel).toBe('Compléter mes informations');
  });

  it('traduit un compte soumis en attente de charges_enabled en PENDING_VERIFICATION', () => {
    const readiness: ConnectedAccountReadiness = {
      organizationPaymentAccountId: 'acc-1',
      providerAccountId: 'acct_123',
      environment: 'TEST',
      onboardingStatus: 'ENABLED',
      chargesEnabled: false,
      payoutsEnabled: false,
      transfersCapabilityStatus: 'PENDING',
      ready: false,
      notConfigured: false,
    };

    const status = resolvePayoutAccountStatus(readiness);

    expect(status.readiness).toBe('PENDING_VERIFICATION');
    expect(status.isReady).toBe(false);
    expect(status.label).toBe('Vérification en cours');
    expect(status.actionLabel).toBeNull();
  });

  it('traduit un compte opérationnel en ENABLED', () => {
    const readiness: ConnectedAccountReadiness = {
      organizationPaymentAccountId: 'acc-1',
      providerAccountId: 'acct_123',
      environment: 'TEST',
      onboardingStatus: 'ENABLED',
      chargesEnabled: true,
      payoutsEnabled: true,
      transfersCapabilityStatus: 'ACTIVE',
      ready: true,
      notConfigured: false,
    };

    const status = resolvePayoutAccountStatus(readiness);

    expect(status.readiness).toBe('ENABLED');
    expect(status.isReady).toBe(true);
    expect(status.label).toBe('Versements opérationnels');
    expect(status.actionLabel).toBeNull();
  });
});
