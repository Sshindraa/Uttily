import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');

describe('UnifiedBookingDetailPage (Chantier 8A, 8B, 8C, 8E & 21-U2.2)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');

  it('exige une autorisation fulfillment pour afficher la fiche réservation', () => {
    expect(pageSource).toContain('requireFulfillmentOperatorOf(orgId)');
    expect(pageSource).toContain('getOperationalBookingDetails(db, organizationId, bookingId)');
  });

  it('intègre les flux unifiés de départ, de retour et d’annulation', () => {
    expect(pageSource).toContain('<DepartureFlow');
    expect(pageSource).toContain('<ReturnFlow');
    expect(pageSource).toContain('<CancellationFlow');
  });

  it('affiche les 4 piliers unifiés et le journal d’activité', () => {
    expect(pageSource).toContain('Vélo réservé');
    expect(pageSource).toContain('Dates &amp; Point de retrait');
    expect(pageSource).toContain('Locataire');
    expect(pageSource).toContain('Journal d’activité du dossier');
  });
});
