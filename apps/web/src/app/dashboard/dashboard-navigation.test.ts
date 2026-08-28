import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LAYOUT_PATH = join(__dirname, '[orgId]', 'layout.tsx');

describe('Dashboard — Navigation IA Pro définitive', () => {
  const layout = readFileSync(LAYOUT_PATH, 'utf8');

  // -----------------------------------------------------------------------
  // 1. Les 8 entrées de navigation exactes
  // -----------------------------------------------------------------------

  const expectedNavEntries = [
    { emoji: '🏠', label: 'Accueil', href: '`/dashboard/${orgId}`' },
    { emoji: '🚲', label: 'Mes vélos', href: '/bikes' },
    { emoji: '📋', label: 'Réservations', href: '/bookings' },
    { emoji: '🔧', label: 'Flotte', href: '/fleet' },
    { emoji: '📍', label: 'Établissements', href: '/locations' },
    { emoji: '💰', label: 'Revenus', href: '/finances' },
    { emoji: '👥', label: 'Équipe', href: '/team' },
    { emoji: '⚙️', label: 'Paramètres', href: '/settings' },
  ];

  it.each(expectedNavEntries)(
    'contient le lien de navigation "$label" ($emoji) vers $href',
    ({ label, href }) => {
      expect(layout).toContain(label);
      expect(layout).toContain(href);
    },
  );

  it('a exactement 8 entrées navLink (pas de Catalogue, Inventaire ni Planning top-level)', () => {
    const navLinkCount = (layout.match(/className=\{styles\.navLink\}/g) ?? []).length;
    expect(navLinkCount).toBe(8);
  });

  // -----------------------------------------------------------------------
  // 2. Aucune ancienne entrée top-level
  // -----------------------------------------------------------------------

  it('ne contient pas les anciens onglets top-level Catalogue, Inventaire ou Planning', () => {
    // On vérifie qu'aucun lien navLink ne pointe vers ces anciens segments.
    // Les chaînes "/catalog" et "/inventory" dans le layout indiqueraient un onglet résiduel.
    // Note : on cherche dans les href du layout, pas dans les redirects (qui sont ailleurs).
    const lines = layout.split('\n');
    const navLinkLines = lines.filter((l) => l.includes('navLink'));
    const navHrefs = navLinkLines.join('\n');

    expect(navHrefs).not.toContain('/catalog');
    expect(navHrefs).not.toContain('/inventory');
    expect(navHrefs).not.toContain('/planning');
    expect(navHrefs).not.toContain('/operations');
  });

  // -----------------------------------------------------------------------
  // 3. Accessibilité de base
  // -----------------------------------------------------------------------

  it('le nav porte un aria-label descriptif', () => {
    expect(layout).toContain('aria-label="Navigation principale"');
  });
});
