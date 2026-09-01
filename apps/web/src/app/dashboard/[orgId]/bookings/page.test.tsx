import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(
  __dirname,
  '../../../../features/operations/operations-bookings-view.tsx',
);

describe('BookingsListPage (Chantier 7A, 7C & 21-U1-D16)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');

  it('exige une autorisation fulfillment pour afficher les réservations', () => {
    expect(pageSource).toContain('requireFulfillmentOperatorOf(orgId)');
    expect(pageSource).toContain('listOperationalBookings(db, organizationId');
  });

  it('utilise un vocabulaire centré sur les Réservations et les départs/retours', () => {
    expect(featureSource).toContain('title="Réservations"');
    expect(featureSource).toContain('Réservation · {booking.bookingItemCount} équipement');
    expect(featureSource).toContain('Préparer le départ →');
    expect(featureSource).toContain('Effectuer le retour →');
  });
});
