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
  'features',
  'bookings',
  'bookings-list-view.tsx',
);

describe('CustomerBookingsPage (Chantier 14B)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');
  const source = `${pageSource}\n${featureSource}`;

  it('exige une authentification locataire et redirige vers sign-in si absent', () => {
    expect(pageSource).toContain('getAuthenticatedUser()');
    expect(pageSource).toContain('redirect_url=');
  });

  it('charge la liste des réservations scopée par l’utilisateur connecté', () => {
    expect(pageSource).toContain('listCustomerBookings(db, user.id)');
  });

  it('structure la vue en 3 sections : À venir, En cours, Historique', () => {
    expect(source).toContain('copy.bookings.upcoming');
    expect(source).toContain('copy.bookings.active');
    expect(source).toContain('copy.bookings.past');
  });

  it('propose un état vide convivial avec CTA vers la recherche', () => {
    expect(source).toContain('copy.bookings.emptyTitle');
    expect(source).toContain('copy.bookings.search');
  });

  it('reste une couche d orchestration et délègue la présentation à la feature', () => {
    expect(pageSource).toContain('<BookingsListView');
    expect(pageSource).not.toContain('className=');
    expect(pageSource).not.toContain('<Card');
  });
});
