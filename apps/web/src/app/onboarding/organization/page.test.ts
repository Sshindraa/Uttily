import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(
  __dirname,
  '../../../features/onboarding/organization-onboarding-view.tsx',
);

describe('Onboarding organisation — entrée loueur', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');
  const source = `${pageSource}\n${featureSource}`;

  it('réserve la création d’organisation aux utilisateurs authentifiés', () => {
    expect(pageSource).toContain('const user = await getAuthenticatedUser();');
    expect(pageSource).toContain("redirect('/sign-in?redirect_url=%2Fonboarding%2Forganization')");
  });

  it('ouvre directement le cockpit de l’organisation créée', () => {
    expect(pageSource).toContain(
      'const { organization } = await createOrganizationAction(payload);',
    );
    expect(pageSource).toContain('redirect(`/dashboard/${organization.id}`);');
  });

  it('laisse la présentation du formulaire à la feature onboarding', () => {
    expect(pageSource).toContain('<OrganizationOnboardingView');
    expect(pageSource).not.toContain('<form');
    expect(source).toContain('<form action={createOrganization}');
  });
});
