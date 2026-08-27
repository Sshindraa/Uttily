import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');

describe('CustomerBookingDetailPage (Chantier 14C, 14D, 14E, 14H)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');

  it('exige une authentification locataire et retourne 404 (notFound) si non trouvé ou non possédé', () => {
    expect(pageSource).toContain('getAuthenticatedUser()');
    expect(pageSource).toContain('getCustomerBooking(db, user.id, bookingId)');
    expect(pageSource).toContain('notFound()');
  });

  it('intègre les cartes contextuelles orientées client (Dates/Lieu, Consignes, Équipements, Documents, Paiement)', () => {
    expect(pageSource).toContain('Dates et lieu de location');
    expect(pageSource).toContain('Consignes & Déroulement');
    expect(pageSource).toContain('Consignes de retrait');
    expect(pageSource).toContain('Équipement réservé');
    expect(pageSource).toContain('Vos documents');
    expect(pageSource).toContain('Votre paiement');
  });

  it('intègre la modale d’annulation locataire avec prévisualisation financière', () => {
    expect(pageSource).toContain('<CustomerCancellationModal');
    expect(pageSource).toContain('booking.cancellation.allowed');
  });
});
