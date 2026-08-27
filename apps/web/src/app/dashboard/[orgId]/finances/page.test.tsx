import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const CLIENT_PATH = join(__dirname, 'finances-client.tsx');

describe('FinancesPage (Revenus & Versements Embedded - Chantier 5)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const clientSource = readFileSync(CLIENT_PATH, 'utf8');

  it('exige une authentification et les droits ROLE_MANAGERS', () => {
    expect(pageSource).toContain('getAuthenticatedUser()');
    expect(pageSource).toContain('requireMembership(membership, ROLE_MANAGERS)');
    expect(pageSource).toContain('getConnectedAccountReadinessAction(orgId)');
  });

  it('utilise resolvePayoutAccountStatus et présente un vocabulaire centré sur les revenus et versements', () => {
    expect(pageSource).toContain('resolvePayoutAccountStatus(readiness)');
    expect(clientSource).toContain('Mes Revenus & Versements');
    expect(clientSource).toContain('Séquestre des fonds & Sécurité bancaire');
    expect(clientSource).not.toContain('Stripe Connect Express');
  });

  it('intègre l’onboarding financier embedded sans redirection externe obligatoire', () => {
    expect(clientSource).toContain('createAccountSessionAction');
    expect(clientSource).toContain('Espace Sécurisé de Configuration Bancaire');
    expect(clientSource).toContain('completeEmbeddedOnboardingSimulationAction');
    expect(clientSource).toContain('handleHostedFallback');
  });
});
