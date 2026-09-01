import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AMEND_DIR = __dirname;
const FEATURE_DIR = join(AMEND_DIR, '../../../../../../features/operations/amendment');

describe('Route canonique bookings/[bookingId]/amend', () => {
  it('rend la page réelle et délègue la présentation à la feature opérations', () => {
    const pageSource = readFileSync(join(AMEND_DIR, 'page.tsx'), 'utf8');
    const pageViewSource = readFileSync(join(FEATURE_DIR, 'amendment-page-view.tsx'), 'utf8');
    const formSource = readFileSync(join(FEATURE_DIR, 'amend-booking-form.tsx'), 'utf8');

    expect(pageSource).toContain("from '@/features/operations'");
    expect(pageSource).toContain('<AmendBookingPageView');
    expect(pageSource).not.toContain('/operations/');
    expect(pageViewSource).toContain('<AmendBookingForm');
    expect(formSource).toContain("from './build-preview-input'");
    expect(formSource).toContain("from './amendment-preview-result'");
  });
});
