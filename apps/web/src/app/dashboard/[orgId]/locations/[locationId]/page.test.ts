import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(
  __dirname,
  '../../../../../',
  'features/locations/location-detail-view.tsx',
);

describe('EditLocationPage — orchestration serveur', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');

  it('conserve les lectures Core et les actions serveur', () => {
    expect(pageSource).toContain('getLocation(db, orgId, locationId)');
    expect(pageSource).toContain('listOpeningHours(db, locationId)');
    expect(pageSource).toContain('listLocationScheduleExceptions(db, orgId, locationId)');
    expect(pageSource).toContain('updateLocationAction');
    expect(pageSource).toContain('upsertLocationScheduleExceptionAction');
    expect(pageSource).toContain('deleteLocationScheduleExceptionAction');
  });

  it('délègue le rendu et les formulaires à la feature locations', () => {
    expect(pageSource).toContain('<LocationDetailView');
    expect(pageSource).not.toContain('<form');
    expect(featureSource).toContain('Fermetures et horaires exceptionnels');
    expect(featureSource).toContain('LocationFormFields');
  });
});
