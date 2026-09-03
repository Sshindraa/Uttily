import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(__dirname, '../../../../features/operations/desk-view.tsx');

describe('BookingsListPage (21-U2-Z — cockpit opérationnel)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');

  it('exige une autorisation fulfillment pour afficher les réservations', () => {
    expect(pageSource).toContain('requireFulfillmentOperatorOf(orgId)');
    expect(pageSource).toContain('getOperationalDeskBookings(db, organizationId');
    expect(pageSource).toContain('listLocations(db, organizationId)');
  });

  it('expose le cockpit, ses trois filtres URL et les flows in situ', () => {
    expect(featureSource).toContain('title="Réservations · Cockpit opérationnel"');
    expect(featureSource).toContain('name="locationId"');
    expect(featureSource).toContain('name="date"');
    expect(featureSource).toContain('name="search"');
    expect(featureSource).toContain("'OVERDUE'");
    expect(featureSource).toContain("'RETURNS_TODAY'");
    expect(featureSource).toContain("'PICKUPS_TODAY'");
    expect(featureSource).toContain("'ONGOING'");
    expect(featureSource).toContain('<DepartureFlow');
    expect(featureSource).toContain('<ReturnFlow');
    expect(featureSource).toContain('<NoShowFlow');
    expect(featureSource).toContain('<SubstitutionFlow');
    expect(featureSource).toContain('<UnreturnedLostFlow');
    expect(featureSource).toContain("booking.bucket === 'OVERDUE'");
    expect(featureSource).toContain('➕ Nouvelle location comptoir');
  });
});
