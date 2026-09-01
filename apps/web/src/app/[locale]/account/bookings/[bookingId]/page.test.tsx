import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'features',
  'bookings',
  'booking-detail-view.tsx',
);

describe('CustomerBookingDetailPage (Chantier 14C, 14D, 14E, 14H)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');
  const source = `${pageSource}\n${featureSource}`;

  it('exige une authentification locataire et retourne 404 (notFound) si non trouvé ou non possédé', () => {
    expect(pageSource).toContain('getAuthenticatedUser()');
    expect(pageSource).toContain('getCustomerBooking(db, user.id, bookingId)');
    expect(pageSource).toContain('notFound()');
  });

  it('intègre les cartes contextuelles orientées client (Dates/Lieu, Consignes, Équipements, Documents, Paiement)', () => {
    expect(source).toContain('copy.detail.datesHeading');
    expect(source).toContain('copy.detail.instructionsHeading');
    expect(source).toContain('copy.detail.pickupInstructions');
    expect(source).toContain('copy.detail.equipmentHeading');
    expect(source).toContain('copy.detail.documentsHeading');
    expect(source).toContain('copy.detail.paymentHeading');
  });

  it('intègre la modale d’annulation locataire avec prévisualisation financière', () => {
    expect(source).toContain('<CustomerCancellationModal');
    expect(source).toContain('booking.cancellation.allowed');
  });

  it('reste une couche d orchestration et délègue la présentation à la feature', () => {
    expect(pageSource).toContain('<BookingDetailView');
    expect(pageSource).not.toContain('className=');
    expect(pageSource).not.toContain('<Card');
  });
});
