import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UttilyBrand } from './uttily-brand';

describe('UttilyBrand', () => {
  it('renders the supplied logo as a decorative image inside an accessible home link', () => {
    const html = renderToStaticMarkup(
      <UttilyBrand href="/" ariaLabel="Uttily, accueil" logoClassName="logo" />,
    );
    expect(html).toMatch(/<a[^>]*aria-label="Uttily, accueil"[^>]*>/);
    expect(html).toContain('uttily-logo.svg');
    expect(html).toContain('alt=""');
    expect(html).toContain('>uttily</span>');
  });

  it('keeps product-area suffixes alongside the same logo', () => {
    const html = renderToStaticMarkup(
      <UttilyBrand href="/dashboard/org" ariaLabel="Uttily Pro, accueil" suffix="Pro" />,
    );
    expect(html).toContain('uttily <em>Pro</em>');
  });
});
