import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AMEND_DIR = __dirname;

describe('Route canonique bookings/[bookingId]/amend', () => {
  it('rend la page réelle et ses composants privés locaux', () => {
    const pageSource = readFileSync(join(AMEND_DIR, 'page.tsx'), 'utf8');
    const formSource = readFileSync(join(AMEND_DIR, 'amend-booking-form.tsx'), 'utf8');

    expect(pageSource).toContain("from './amend-booking-form'");
    expect(pageSource).toContain('<AmendBookingForm');
    expect(pageSource).not.toContain('/operations/');
    expect(formSource).toContain("from './build-preview-input'");
    expect(formSource).toContain("from './amendment-preview-result'");
  });
});
