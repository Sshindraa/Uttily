import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FORM_PATH = join(__dirname, 'new-bike-form.tsx');

describe('NewBikePage (/bikes/new)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const formSource = readFileSync(FORM_PATH, 'utf8');

  it('exige les droits de gestionnaire de catalogue et charge les catégories', () => {
    expect(pageSource).toContain('requireCatalogManagerOf(orgId)');
    expect(pageSource).toContain('listCategories(db)');
  });

  it('propose un formulaire simple d’étape 1 et appelle createBikeDraftAction', () => {
    expect(formSource).toContain('createBikeDraftAction');
    expect(formSource).toContain('Étape 1 sur 5');
    expect(formSource).toContain('Nom commercial de l’équipement');
    expect(formSource).toContain('Taille / Version');
    expect(formSource).toContain('/setup');
  });
});
