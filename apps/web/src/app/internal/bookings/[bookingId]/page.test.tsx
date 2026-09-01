import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(__dirname, '../../../../features/internal/booking-support-view.tsx');

describe('BookingSupportPage (Chantier 16 & 21-U1-D22)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');

  it('garde la protection plateforme, la lecture Core et le 404 dans la route', () => {
    expect(pageSource).toContain('requireSupportPlatformAdmin');
    expect(pageSource).toContain('getBookingSupportDetails');
    expect(pageSource).toContain('SupportBookingNotFoundError');
    expect(pageSource).toContain('<BookingSupportView');
  });

  it('déporte le diagnostic 360° et les actions interactives dans la feature interne', () => {
    expect(featureSource).toContain('BookingSupportDetails');
    expect(featureSource).toContain('Diagnostic Financier Consolidé');
    expect(featureSource).toContain('RetryNotificationButton');
    expect(featureSource).not.toContain('requireSupportPlatformAdmin');
  });
});
