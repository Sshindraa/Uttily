import { readFileSync } from 'node:fs';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { HomeNavigation } from './home-navigation';
import { ClientShell } from './client-shell';
import { LanguageDialog } from './language-dialog';
import HomePage from '@/app/page';

const session = vi.hoisted(() => ({ signedIn: false }));
vi.mock('@clerk/nextjs', () => ({
  SignedIn: ({ children }: { children: ReactNode }) => (session.signedIn ? children : null),
  SignedOut: ({ children }: { children: ReactNode }) => (session.signedIn ? null : children),
  UserButton: () => <span>Gestion du compte Clerk</span>,
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn() }),
}));

describe('Uttily homepage navigation', () => {
  it('keeps the Uttily wordmark in Sora Regular', () => {
    const css = readFileSync(new URL('./home-navigation.module.css', import.meta.url), 'utf8');
    const brand = css.match(/\.brand\s*\{([^}]+)\}/)?.[1];
    expect(brand).toContain('font-weight: var(--ut-weight-regular)');
  });

  it('uses the supplied vector symbol with a tight canvas and an accessible home link', () => {
    const html = renderToStaticMarkup(<HomeNavigation />);
    expect(html).toMatch(/aria-label="Uttily, accueil"[^>]*><img[^>]*alt=""/);
    expect(html).toContain('src="/images/brand/uttily-logo.svg"');
    const svg = readFileSync(
      new URL('../../../../public/images/brand/uttily-logo.svg', import.meta.url),
      'utf8',
    );
    expect(svg).toContain('viewBox="584 528 988 992"');
    expect(svg).toContain('fill="#8cb6bf"');
    expect(svg).not.toMatch(/<script|<foreignObject|(?:href|src)=/i);
  });

  it('keeps the language control without a discovery link in the header', () => {
    const html = renderToStaticMarkup(<HomeNavigation />);
    const languageButton = html.match(/<button[^>]*aria-label="Choisir la langue"[^>]*>/)?.[0];
    expect(languageButton).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('Trouver un équipement');
    expect(html).not.toContain('Find equipment');
    expect(html).not.toContain('Navigation principale');
  });

  it('renders only supported language choices and marks the active one', () => {
    const html = renderToStaticMarkup(
      <LanguageDialog open locale="en" onClose={() => undefined} />,
    );
    expect(html).toContain('Personalize your experience');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('Français');
    expect(html).toContain('English');
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toMatch(/href="\/\?lang=en"[^>]*aria-current="true"/);
    expect(
      renderToStaticMarkup(<LanguageDialog open={false} locale="fr" onClose={() => undefined} />),
    ).toBe('');
  });

  it('applies English to the homepage and its public links', async () => {
    const html = renderToStaticMarkup(
      await HomePage({ searchParams: Promise.resolve({ lang: 'en' }) }),
    );
    expect(html).toContain('Your equipment');
    expect(html).toContain('is waiting.');
    expect(html).toContain('href="/en/search"');
    expect(html).toContain('href="/en/account/bookings"');
    expect(html).toContain('lang="en"');
    expect(html).not.toContain('href="/fr/search"');
  });

  it('defaults to French and rejects unsupported or repeated language parameters', async () => {
    for (const lang of [undefined, 'es', ['en', 'fr']]) {
      const html = renderToStaticMarkup(
        await HomePage({ searchParams: Promise.resolve({ lang }) }),
      );
      expect(html).toContain('Votre équipement');
      expect(html).toContain('vous attend.');
      expect(html).toContain('href="/fr/search"');
    }
  });
  it('renders the French navigation instead of the four reference categories', () => {
    const html = renderToStaticMarkup(<HomeNavigation />);
    expect(html).toContain('>uttily</span>');
    expect(html).not.toContain('>airbnb<');
    for (const label of ['>All<', 'Homes', 'Experiences', 'Services', 'Become a host']) {
      expect(html).not.toContain(label);
    }
    expect(html).not.toContain('Trouver un équipement');
    expect(html).toContain('Vous êtes loueur');
    expect(html).not.toContain('aria-current="page"');
    expect(html).toContain('aria-label="Mon compte"');
    expect(html).toContain('Mon espace');
    expect(html).not.toContain('>H</span>');
  });

  it('keeps the menu and host links within the existing Uttily routes', () => {
    const html = renderToStaticMarkup(<HomeNavigation />);
    for (const href of ['/onboarding/organization', '/fr/account/bookings', '/dashboard']) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toContain('<details');
    expect(html).toContain('aria-label="Menu principal"');
    expect(html).toContain('href="#home-heading"');
    expect(html).not.toMatch(/href="https?:/);
  });

  it('preserves signed-in and signed-out account controls', () => {
    session.signedIn = false;
    expect(renderToStaticMarkup(<HomeNavigation />)).toContain('Se connecter');
    session.signedIn = true;
    const html = renderToStaticMarkup(<HomeNavigation />);
    expect(html).toContain('Gestion du compte Clerk');
    expect(html).not.toContain('Se connecter');
    session.signedIn = false;
  });

  it('replaces only the homepage header and preserves shell content and footer', () => {
    const html = renderToStaticMarkup(
      <ClientShell header={<HomeNavigation />}>
        <main>Contenu conservé</main>
      </ClientShell>,
    );
    expect(html.match(/<header/g)).toHaveLength(1);
    expect(html).toContain('Contenu conservé');
    expect(html).toContain('<footer');
    expect(html).not.toContain('aria-label="Navigation client"');
    const defaultHtml = renderToStaticMarkup(
      <ClientShell>
        <main>Autre page</main>
      </ClientShell>,
    );
    expect(defaultHtml).toContain('aria-label="Navigation client"');
    expect(defaultHtml).not.toContain('Navigation principale');
  });

  it('keeps only the account menu and the supplied brand controls', () => {
    const html = renderToStaticMarkup(<HomeNavigation />);
    expect(html.match(/<details/g)).toHaveLength(1);
    expect(html).not.toContain('Rechercher une destination');
    expect(html).toContain('/images/brand/uttily-logo.svg');
    expect(html).not.toContain('/images/home-navigation/');
    const source = readFileSync(new URL('./home-navigation.tsx', import.meta.url), 'utf8');
    expect(source).toContain('name="globe"');
    expect(source).not.toContain('placesMenu');
  });

  it('has mobile layout and keyboard dismissal safeguards (static source check)', () => {
    const css = readFileSync(new URL('./home-navigation.module.css', import.meta.url), 'utf8');
    const source = readFileSync(new URL('./home-navigation.tsx', import.meta.url), 'utf8');
    expect(css).toContain('@media (max-width: 36rem)');
    expect(css).toContain('grid-row: 2');
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain("querySelector('summary')?.focus()");
  });
});
