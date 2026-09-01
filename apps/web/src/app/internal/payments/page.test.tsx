import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const FEATURE_PATH = join(__dirname, '../../../features/internal/payments-support-view.tsx');

describe('PaymentsSupportPage (Chantier 16 & 21-U1-D23)', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const featureSource = readFileSync(FEATURE_PATH, 'utf8');

  it('garde la protection plateforme, le filtre et la lecture Core dans la route', () => {
    expect(pageSource).toContain('requireSupportPlatformAdmin');
    expect(pageSource).toContain('listPaymentsSupport');
    expect(pageSource).toContain('validStatus');
    expect(pageSource).toContain('<PaymentsSupportView');
  });

  it('déporte le tableau et la réconciliation dans la feature interne', () => {
    expect(featureSource).toContain('Diagnostic Paiements & Remboursements');
    expect(featureSource).toContain('ReconcilePaymentButton');
    expect(featureSource).not.toContain('requireSupportPlatformAdmin');
  });
});
