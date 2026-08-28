import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');

describe('PlanningPage (Chantier 10)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');

  it('exige une autorisation fulfillment pour afficher le planning', () => {
    expect(pageSource).toContain('requireFulfillmentOperatorOf(orgId)');
    expect(pageSource).toContain('getOperationalPlanning');
  });

  it('intègre le composant interactif PlanningView', () => {
    expect(pageSource).toContain('<PlanningView');
  });
});
