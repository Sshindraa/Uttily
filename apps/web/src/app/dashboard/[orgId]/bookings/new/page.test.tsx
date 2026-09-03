import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(__dirname, '../../../../../features/operations/counter-booking-view.tsx');

describe('NewCounterBookingPage (Lot 21-U2-AD — réservation comptoir)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');

  it('exige une autorisation opérateur fulfillment et charge les matériels disponibles', () => {
    expect(pageSource).toContain('requireFulfillmentOperatorOf(orgId)');
    expect(pageSource).toContain('listLocations(db, organizationId)');
    expect(pageSource).toContain('getCounterAvailableItems(db');
    expect(pageSource).toContain('<CounterBookingView');
  });

  it('propose les canaux, presets de durée, filtres de matériel et modes de règlement comptoir', () => {
    expect(featureSource).toContain('title="Nouvelle location comptoir"');
    expect(featureSource).toContain('Comptoir (Walk-in)');
    expect(featureSource).toContain('Téléphone');
    expect(featureSource).toContain('⏱️ 2 Heures');
    expect(featureSource).toContain('⛅ Demi-journée (4h)');
    expect(featureSource).toContain('☀️ Journée complète');
    expect(featureSource).toContain('📅 2 Jours (Week-end)');
    expect(featureSource).toContain('Matériel disponible sur ce créneau');
    expect(featureSource).toContain('💳 Carte (TPE)');
    expect(featureSource).toContain('💶 Espèces');
    expect(featureSource).toContain('🎟️ Chèque-Vacances');
    expect(featureSource).toContain('📝 Chèque');
    expect(featureSource).toContain('⏳ Règlement ultérieur');
    expect(featureSource).toContain('createCounterBookingAction');
  });
});
