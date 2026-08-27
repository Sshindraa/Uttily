import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const HUB_PATH = join(__dirname, 'finances-hub.tsx');

describe('FinancesPage (Revenus & Versements V2 - Chantier 11)', () => {
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
    expect(hubSource).toContain('Revenus &amp; Versements');
    expect(hubSource).toContain('Revenus après commission Uttily');
    expect(hubSource).toContain('Séquestre des fonds &amp; Sécurité bancaire');
    expect(hubSource).not.toContain('Stripe Connect Express');
  });

  it('intègre l’onboarding financier embedded sans redirection externe obligatoire et l’export CSV', () => {
    expect(hubSource).toContain('createAccountSessionAction');
    expect(hubSource).toContain('completeEmbeddedOnboardingSimulationAction');
    expect(hubSource).toContain('handleHostedFallback');
    expect(hubSource).toContain('export-csv');
  });
});
