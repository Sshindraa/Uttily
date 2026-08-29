import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const HUB_PATH = join(__dirname, 'finances-hub.tsx');

describe('FinancesPage (Revenus & Versements V2 - Chantier 11.1 & 21-U2.3)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const hubSource = readFileSync(HUB_PATH, 'utf8');

  it('exige une authentification, les droits ROLE_MANAGERS et charge getMerchantFinanceOverview', () => {
    expect(pageSource).toContain('getAuthenticatedUser()');
    expect(pageSource).toContain('requireMembership(membership, ROLE_MANAGERS)');
    expect(pageSource).toContain('getConnectedAccountReadinessAction(orgId)');
    expect(pageSource).toContain('getMerchantFinanceOverview(db, orgId');
  });

  it('utilise resolvePayoutAccountStatus et présente un vocabulaire centré sur les revenus et versements', () => {
    expect(pageSource).toContain('resolvePayoutAccountStatus(readiness)');
    expect(hubSource).toContain('Revenus & Versements');
    expect(hubSource).toContain('Volume brut réservations');
    expect(hubSource).toContain('partenaire de paiement');
    expect(hubSource).not.toContain('Stripe Connect Express');
  });

  it('intègre l’onboarding financier embedded sans redirection externe obligatoire et sans formulaire local sensible', () => {
    expect(hubSource).toContain('createAccountSessionAction');
    expect(hubSource).toContain('ConnectComponentsProvider');
    expect(hubSource).toContain('ConnectAccountOnboarding');
    expect(hubSource).toContain('ConnectAccountManagement');
    expect(hubSource).toContain('handleHostedFallback');
    expect(hubSource).toContain('export-csv');
    expect(hubSource).not.toContain('completeEmbeddedOnboardingSimulationAction');
    expect(hubSource).not.toContain('iban');
    expect(hubSource).not.toContain('siren');
  });
});
