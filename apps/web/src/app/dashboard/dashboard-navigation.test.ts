import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LAYOUT_PATH = join(__dirname, '[orgId]', 'pro-shell.tsx');

describe('Dashboard — Navigation IA Pro définitive', () => {
  const layout = readFileSync(LAYOUT_PATH, 'utf8');

  // -----------------------------------------------------------------------
  // 1. Les 8 entrées de navigation exactes
  // -----------------------------------------------------------------------

  const expectedNavEntries = [
    { label: 'Accueil', href: '`/dashboard/${orgId}`' },
    { label: 'Mes vélos', href: '/bikes' },
    { label: 'Réservations', href: '/bookings' },
    { label: 'Flotte', href: '/fleet' },
    { label: 'Établissements', href: '/locations' },
    { label: 'Revenus', href: '/finances' },
    { label: 'Équipe', href: '/team' },
    { label: 'Paramètres', href: '/settings' },
  ];

  it.each(expectedNavEntries)(
    'contient le lien de navigation "$label" vers $href',
    ({ label, href }) => {
      expect(layout).toContain(label);
      expect(layout).toContain(href);
    },
  );

  it('a exactement 8 entrées dans la configuration de navigation', () => {
    const navItemCount = (layout.match(/label: '/g) ?? []).length;
    expect(navItemCount).toBe(8);
  });

  // -----------------------------------------------------------------------
  // 2. Aucune ancienne entrée top-level
  // -----------------------------------------------------------------------

  it('ne contient pas les anciens onglets top-level Catalogue, Inventaire ou Planning', () => {
    expect(layout).not.toContain("label: 'Catalogue'");
    expect(layout).not.toContain("label: 'Inventaire'");
    expect(layout).not.toContain("label: 'Planning'");
    expect(layout).not.toContain("label: 'Opérations'");
  });

  // -----------------------------------------------------------------------
  // 3. Accessibilité de base
  // -----------------------------------------------------------------------

  it('le nav porte un aria-label descriptif', () => {
    expect(layout).toContain('aria-label="Navigation principale"');
    expect(layout).toContain("aria-current={active ? 'page' : undefined}");
  });
});
