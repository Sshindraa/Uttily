import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { HomeHero } from './home-hero';

vi.mock('@/app/actions/home-search-options', () => ({ loadHomeSearchOptions: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe('Immersive homepage', () => {
  it('keeps the original hero PNG bytes instead of a downscaled derivative', () => {
    const image = readFileSync(
      new URL('../../../public/images/home/mountain-lake-road.png', import.meta.url),
    );

    expect(createHash('sha256').update(image).digest('hex')).toBe(
      '79766eb94887144c3949ae1d4228ca890f057582f7667cdc35fdae92519b3b8b',
    );
  });

  it('uses the requested Fontshare display pairing for the hero heading', () => {
    const css = readFileSync(new URL('./home-hero.module.css', import.meta.url), 'utf8');

    expect(css).toContain("url('/fonts/chillax/chillax-regular.woff2')");
    expect(css).toContain("font-family: 'Chillax'");
    expect(css).toContain('font-weight: 400');
    expect(css).toContain("url('/fonts/boska/boska-medium-italic.woff2')");
    expect(css).toContain("font-family: 'Boska'");
    expect(css).toContain('font-style: italic');
  });

  it('includes subtle parallax wrapper and styles for depth on scroll', () => {
    const css = readFileSync(new URL('./home-hero.module.css', import.meta.url), 'utf8');
    expect(css).toContain('.parallaxWrapper');
    expect(css).toContain('will-change: transform');
    expect(css).toContain('prefers-reduced-motion: reduce');

    const html = renderToStaticMarkup(<HomeHero locale="fr" />);
    expect(html).toContain('parallaxWrapper');
  });

  it('shows the editorial photo and four intent fields with a direct search action', () => {
    const html = renderToStaticMarkup(<HomeHero locale="fr" />);
    expect(html).toContain('Louez votre équipement,');
    expect(html).toContain('là où vous partez.');
    expect(html).toContain('/_next/image?url=%2Fimages%2Fhome%2Fmountain-lake-road.png');
    expect(html).toContain('Destination');
    expect(html).toContain('Équipement');
    expect(html).toContain('Quand ?');
    expect(html).toContain('Personnes');
    expect(html).toContain('Rechercher');
    expect(html).toContain('type="submit"');
    expect(html).toContain('Paiement sécurisé');
    expect(html).toContain('Loueurs professionnels');
    expect(html).toContain('Retrait sur place');
    expect(html.indexOf('Destination')).toBeLessThan(html.indexOf('Décrivez votre sortie'));
    expect(html).not.toContain('Location de matériel');
    expect(html.match(/aria-haspopup="dialog"/g)).toHaveLength(4);
    expect(html).toContain('href="/fr/search"');
    expect(html).not.toContain('Photo d’inspiration');
    expect(html).not.toContain('Nick Page / Unsplash');
    expect(html).not.toContain('CHICAGO');
    expect(html).not.toContain('Lyon, ARA');
  });
  it('translates the search entry points and fallback', () => {
    const html = renderToStaticMarkup(<HomeHero locale="en" />);
    expect(html).toContain('Rent your equipment,');
    expect(html).toContain('where you go.');
    expect(html).toContain('Equipment');
    expect(html).toContain('People');
    expect(html).toContain('Search');
    expect(html).toContain('Secure payment');
    expect(html).toContain('Professional rental operators');
    expect(html).toContain('Pickup on site');
    expect(html).toContain('href="/en/search"');
    expect(html).not.toContain('Inspiration photo');
  });
  it('composes beneath the existing homepage navigation without duplicating it', () => {
    const page = readFileSync(new URL('../../app/page.tsx', import.meta.url), 'utf8');
    expect(page).toContain('header={<HomeNavigation locale={locale} sticky={false} />}');
    const html = renderToStaticMarkup(<HomeHero locale="fr" />);
    expect(html).not.toContain('<header');
    expect(html).not.toContain('<nav');
  });
});
