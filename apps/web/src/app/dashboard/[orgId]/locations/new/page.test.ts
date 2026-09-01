import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(__dirname, '../../../../../features/locations/new-location-view.tsx');

describe('NewLocationPage — orchestration serveur', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');

  it('conserve l’authentification, le RBAC et la mutation serveur', () => {
    expect(pageSource).toContain('getAuthenticatedUser()');
    expect(pageSource).toContain('requireMembership(membership, LOCATION_MANAGERS)');
    expect(pageSource).toContain('createLocationAction');
    expect(pageSource).toContain('parseLocationFormData(formData)');
  });

  it('délègue le rendu du formulaire à la feature locations', () => {
    expect(pageSource).toContain('<NewLocationView');
    expect(pageSource).not.toContain('<form');
    expect(featureSource).toContain('<LocationFormFields />');
  });
});
