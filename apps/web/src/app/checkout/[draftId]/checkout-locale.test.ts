import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE_PATH = join(__dirname, 'page.tsx');
const CLIENT_PATH = join(__dirname, '../../../features/checkout/checkout-client.tsx');
const FORM_PATH = join(__dirname, '../../../features/offers/offer-booking-form.tsx');

describe('checkout locale continuity', () => {
  const pageSource = readFileSync(PAGE_PATH, 'utf8');
  const clientSource = readFileSync(CLIENT_PATH, 'utf8');
  const formSource = readFileSync(FORM_PATH, 'utf8');

  it('carries the locale from the offer to checkout and back through payment', () => {
    expect(formSource).toContain('locale=${locale}');
    expect(pageSource).toContain('searchParams');
    expect(pageSource).toContain('locale=${locale}');
    expect(pageSource).toContain('localeOverride={locale}');
    expect(pageSource).toContain(
      'returnUrl={`${publicAppUrl}/checkout/${draftId}?locale=${locale}`}',
    );
  });

  it('formats checkout amounts and dates using the carried locale', () => {
    expect(clientSource).toContain('locale: localeOverride');
    expect(clientSource).toContain('getIntlLocale(locale)');
  });

  it('keeps the checkout route focused on server orchestration', () => {
    expect(pageSource).toContain('<CheckoutPageView');
    expect(pageSource).toContain('<CheckoutStatus');
    expect(pageSource).not.toContain('<CheckoutClient');
    expect(pageSource).not.toContain('style={{');
  });
});
