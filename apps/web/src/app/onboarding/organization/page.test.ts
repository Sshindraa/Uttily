import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');

describe('Onboarding organisation — entrée loueur', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');

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
});
