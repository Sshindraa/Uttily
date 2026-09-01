import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { HomeHero } from './home-hero';

vi.mock('@/app/actions/home-search-options', () => ({ loadHomeSearchOptions: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe('Immersive homepage', () => {
  it('shows the editorial photo and four intent fields with a direct search action', () => {
    const html = renderToStaticMarkup(<HomeHero locale="fr" />);
    expect(html).toContain('Votre équipement');
    expect(html).toContain('vous attend.');
    expect(html).toContain('cycling-sunset.jpg');
    expect(html).toContain('Destination');
    expect(html).toContain('Équipement');
    expect(html).toContain('Dates');
    expect(html).toContain('Personnes');
    expect(html).toContain('type="submit"');
    expect(html).toContain('Réservez en ligne.');
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
    expect(html).toContain('is waiting.');
    expect(html).toContain('Equipment');
    expect(html).toContain('People');
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
