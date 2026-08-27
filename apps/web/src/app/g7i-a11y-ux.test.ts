/**
 * @uttily/web — G7I Lot 7 static accessibility guardrails.
 *
 * Tests d'analyse statique (static source analysis) vérifiant la structure
 * source : labels, rôles, live regions et media queries.
 *
 * Ces tests vérifient la structure du code source, PAS une navigation clavier
 * réellement exécutée. Ils garantissent que les attributs ARIA, labels et media
 * queries sont présents dans le source.
 *
 * Aucun Playwright, aucun rendu DOM, aucune nouvelle dépendance.
 *
 * Date de travail : 2026-08-15.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('G7I — static accessibility guardrails', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // search-form.tsx — labels, keyboard-accessible inputs, aria-describedby
  // ─────────────────────────────────────────────────────────────────────────
  const searchForm = readFileSync(join(__dirname, '[locale]/search/search-form.tsx'), 'utf8');
  const searchResults = readFileSync(join(__dirname, '[locale]/search/search-results.tsx'), 'utf8');
  const searchCss = readFileSync(join(__dirname, '[locale]/search/search.module.css'), 'utf8');
  const checkoutClient = readFileSync(
    join(__dirname, 'checkout/[draftId]/checkout-client.tsx'),
    'utf8',
  );
  const offerPage = readFileSync(
    join(__dirname, '[locale]/offers/[publicProductId]/[publicLocationId]/page.tsx'),
    'utf8',
  );
  const offerForm = readFileSync(
    join(__dirname, '[locale]/offers/[publicProductId]/[publicLocationId]/offer-booking-form.tsx'),
    'utf8',
  );
  const offerCss = readFileSync(
    join(__dirname, '[locale]/offers/[publicProductId]/[publicLocationId]/offer.module.css'),
    'utf8',
  );

  it('search-form.tsx: labels use htmlFor, inputs/selects are keyboard-accessible, aria-describedby for errors', () => {
    // Labels associated via htmlFor
    expect(searchForm).toContain('htmlFor="destinationQuery"');
    expect(searchForm).toContain('htmlFor="intent"');
    expect(searchForm).toContain('htmlFor="startDate"');
    expect(searchForm).toContain('htmlFor="endDateExclusive"');
    expect(searchForm).toContain('htmlFor="startAt"');
    expect(searchForm).toContain('htmlFor="endAt"');
    expect(searchForm).toContain('htmlFor="categoryId"');

    // Native <select> and <input> elements are keyboard-accessible by default
    expect(searchForm).toContain('<select');
    expect(searchForm).toContain('<input');
    expect(searchForm).toContain('type="date"');
    expect(searchForm).toContain('type="datetime-local"');

    // aria-describedby for error messages
    expect(searchForm).toContain('aria-describedby');
    expect(searchForm).toContain('destination-error');
    expect(searchForm).toContain('start-date-error');
    expect(searchForm).toContain('end-time-error');
  });

  it('search-results.tsx: aria-live, role attributes, loading/empty states', () => {
    // aria-live on the results section
    expect(searchResults).toContain('aria-live="polite"');
    expect(searchResults).toContain('aria-busy=');

    // role attributes for error and status
    expect(searchResults).toContain('role="alert"');
    expect(searchResults).toContain('role="status"');

    // Loading state
    expect(searchResults).toContain('isFetching');
    expect(searchResults).toContain('Recherche dans la zone');

    // Empty state
    expect(searchResults).toContain('Aucun résultat exact');
    expect(searchResults).toContain('Aucune offre exacte');

    // Headings with id for aria-labelledby references
    expect(searchResults).toContain('id="search-results-heading"');
    expect(searchResults).toContain('aria-labelledby="exact-results-heading"');

    // Geographic alternatives remain visible in distinct, accessible sections
    expect(searchResults).toContain("item.geographicMatch === 'RADIUS_10KM'");
    expect(searchResults).toContain("item.geographicMatch === 'RADIUS_25KM'");
    expect(searchResults).toContain("item.geographicMatch === 'RADIUS_50KM'");
    expect(searchResults).toContain("id: 'radius-10-results'");
    expect(searchResults).toContain("id: 'radius-25-results'");
    expect(searchResults).toContain("id: 'radius-50-results'");
    expect(searchResults).toContain('Alternative à moins de 10 km');
  });

  it('checkout-client.tsx: aria-live, role="alert" for errors, loading states', () => {
    // aria-live / role for errors
    expect(checkoutClient).toContain('role="alert"');

    // Loading states with role="status" and aria-busy
    expect(checkoutClient).toContain('role="status"');
    expect(checkoutClient).toContain('aria-busy=');

    // Headings with aria-labelledby
    expect(checkoutClient).toContain('aria-labelledby="checkout-heading"');
    expect(checkoutClient).toContain('aria-labelledby="success-heading"');
    expect(checkoutClient).toContain('aria-labelledby="error-heading"');

    // Submit button has aria-label for clarity
    expect(checkoutClient).toContain('aria-label=');
  });

  it('offer page.tsx: labels, headings, primary action clarity', () => {
    // Headings hierarchy
    expect(offerPage).toContain('<h1');
    expect(offerPage).toContain('<h2');
    expect(offerPage).toContain('aria-labelledby="location-heading"');
    expect(offerPage).toContain('aria-labelledby="hours-heading"');

    // Navigation with aria-label
    expect(offerPage).toContain('aria-label=');

    // Primary action is clear (the booking form has a clear submit button)
    expect(offerForm).toContain('type="submit"');
    expect(offerForm).toContain('Réserver');
    expect(offerForm).toContain('Book now');
  });

  it('offer-booking-form.tsx: labels with htmlFor, role="alert" for errors, fieldset/legend', () => {
    // Labels associated via htmlFor
    expect(offerForm).toContain('htmlFor="booking-start-date"');
    expect(offerForm).toContain('htmlFor="booking-end-date"');
    expect(offerForm).toContain('htmlFor="booking-start-time"');
    expect(offerForm).toContain('htmlFor="booking-end-time"');

    // Error display with role="alert"
    expect(offerForm).toContain('role="alert"');

    // fieldset/legend for variant radio group
    expect(offerForm).toContain('<fieldset');
    expect(offerForm).toContain('<legend');

    // noValidate is acceptable (server-side validation is the authority)
    expect(offerForm).toContain('noValidate');
  });

  it('mobile-responsive: search page has responsive CSS media queries', () => {
    // search.module.css has @media rules for responsive layout
    expect(searchCss).toContain('@media');
    expect(searchCss).toMatch(/max-width:\s*640px|max-width:\s*1000px/);
  });

  it('mobile-responsive: offer page has responsive CSS media queries', () => {
    // offer.module.css has @media rules for responsive layout
    expect(offerCss).toContain('@media');
    expect(offerCss).toMatch(/min-width:\s*860px|max-width/);
  });

  it('accessible error messages: search and checkout use aria-live="polite" or role="alert" on error display elements', () => {
    // search-results uses aria-live="polite" on the section and role="alert" on error <p>
    expect(searchResults).toContain('aria-live="polite"');
    expect(searchResults).toContain('role="alert"');

    // checkout uses role="alert" on error display
    expect(checkoutClient).toContain('role="alert"');

    // offer-booking-form uses role="alert" on error display
    expect(offerForm).toContain('role="alert"');
  });

  it('checkout is mobile-first: inline styles use maxWidth and full-width buttons', () => {
    // The checkout uses maxWidth for the section (mobile-first container)
    expect(checkoutClient).toContain('maxWidth: 480');
    // Submit button is full width (mobile-friendly)
    expect(checkoutClient).toContain("width: '100%'");
  });
});
