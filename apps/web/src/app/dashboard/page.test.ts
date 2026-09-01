import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const VIEW_PATH = join(
  __dirname,
  '..',
  '..',
  'features',
  'dashboard',
  'organization-selector-view.tsx',
);

describe('Dashboard — aiguillage initial du loueur', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const viewSource = readFileSync(VIEW_PATH, 'utf8');

  it('redirige un utilisateur authentifié sans organisation vers l’onboarding', () => {
    expect(pageSource).toContain(
      "if (organizations.length === 0) redirect('/onboarding/organization');",
    );
  });

  it('ne conserve pas un état vide comme destination finale du dashboard', () => {
    expect(viewSource).not.toContain('Aucune organisation');
    expect(viewSource).toContain('Mes organisations');
  });
});
