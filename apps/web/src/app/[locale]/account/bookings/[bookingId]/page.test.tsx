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
    expect(pageSource).toContain('copy.detail.datesHeading');
    expect(pageSource).toContain('copy.detail.instructionsHeading');
    expect(pageSource).toContain('copy.detail.pickupInstructions');
    expect(pageSource).toContain('copy.detail.equipmentHeading');
    expect(pageSource).toContain('copy.detail.documentsHeading');
    expect(pageSource).toContain('copy.detail.paymentHeading');
  });

  it('intègre la modale d’annulation locataire avec prévisualisation financière', () => {
    expect(pageSource).toContain('<CustomerCancellationModal');
    expect(pageSource).toContain('booking.cancellation.allowed');
  });
});
