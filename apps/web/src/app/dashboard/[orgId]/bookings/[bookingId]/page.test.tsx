import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(__dirname, '../../../../../features/operations/booking-detail-view.tsx');

describe('UnifiedBookingDetailPage (Chantier 8A, 8B, 8C, 8E & 21-U1-D16)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');

  it('exige une autorisation fulfillment pour afficher la fiche réservation', () => {
    expect(pageSource).toContain('requireFulfillmentOperatorOf(orgId)');
    expect(pageSource).toContain('getOperationalBookingDetails(db, organizationId, bookingId)');
  });

  it('intègre les flux unifiés de départ, de retour et d’annulation', () => {
    expect(featureSource).toContain('<DepartureFlow');
    expect(featureSource).toContain('<ReturnFlow');
    expect(featureSource).toContain('<CancellationFlow');
  });

  it('affiche les 4 piliers unifiés et le journal d’activité', () => {
    expect(featureSource).toContain('Équipement réservé');
    expect(featureSource).toContain('Référence exemplaire');
    expect(featureSource).toContain('Dates &amp; Point de retrait');
    expect(featureSource).toContain('Locataire');
    expect(featureSource).toContain('Journal d’activité du dossier');
  });
});
