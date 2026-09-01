import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(__dirname, '../../../../../features/planning/planning-view.tsx');

describe('PlanningPage (Chantier 10 & 21-U1-D15)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');

  it('exige une autorisation fulfillment pour afficher le planning', () => {
    expect(pageSource).toContain('requireFulfillmentOperatorOf(orgId)');
    expect(pageSource).toContain('getOperationalPlanning');
  });

  it('intègre le composant interactif PlanningView', () => {
    expect(pageSource).toContain('<PlanningView');
    expect(featureSource).toContain("'use client'");
    expect(featureSource).toContain('Vue Planning');
    expect(featureSource).toContain('Vue Flotte');
  });
});
