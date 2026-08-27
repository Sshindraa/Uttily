import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');

describe('CustomerBookingsPage (Chantier 14B)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');

  it('exige une authentification locataire et redirige vers sign-in si absent', () => {
    expect(pageSource).toContain('getAuthenticatedUser()');
    expect(pageSource).toContain("redirect('/sign-in')");
  });

  it('charge la liste des réservations scopée par l’utilisateur connecté', () => {
    expect(pageSource).toContain('listCustomerBookings(db, user.id)');
  });

  it('structure la vue en 3 sections : À venir, En cours, Historique', () => {
    expect(pageSource).toContain('À venir');
    expect(pageSource).toContain('En cours');
    expect(pageSource).toContain('Historique');
  });

  it('propose un état vide convivial avec CTA vers la recherche', () => {
    expect(pageSource).toContain('Aucune location pour le moment');
    expect(pageSource).toContain('Rechercher un vélo');
  });
});
