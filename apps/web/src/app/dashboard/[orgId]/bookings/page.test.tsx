import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');

describe('BookingsListPage (Chantier 7A, 7C & 21-U2.2)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');

  it('exige une autorisation fulfillment pour afficher les réservations', () => {
    expect(pageSource).toContain('requireFulfillmentOperatorOf(orgId)');
    expect(pageSource).toContain('listOperationalBookings(db, organizationId');
  });

  it('utilise un vocabulaire centré sur les Réservations et les départs/retours', () => {
    expect(pageSource).toContain('title="Réservations"');
    expect(pageSource).toContain('Préparer le départ →');
    expect(pageSource).toContain('Effectuer le retour →');
  });
});
