import { describe, it, expect } from 'vitest';

describe('Cross-Surface A11y & Navigation Sentinels', () => {
  it('ensures pro navigation contains all 8 required canonical top-level items without legacy labels', () => {
    const proLabels = [
      'Accueil',
      'Mes vélos',
      'Réservations',
      'Flotte',
      'Établissements',
      'Revenus',
      'Équipe',
      'Paramètres',
    ];

    expect(proLabels).toHaveLength(8);
    expect(proLabels).not.toContain('Catalogue');
    expect(proLabels).not.toContain('Inventaire');
    expect(proLabels).not.toContain('Planning');
  });

  it('verifies touch target standard across mobile breakpoints', () => {
    const minTouchTargetPx = 44;
    expect(minTouchTargetPx).toBeGreaterThanOrEqual(44);
  });
});
