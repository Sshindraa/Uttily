'use client';

import Link from 'next/link';
import { SignedIn, SignedOut, UserButton } from '@clerk/nextjs';
import { Button, Icon, LinkButton } from '@uttily/ui';
import { useEffect, useRef, useState } from 'react';
import type { AppLocale } from '@/lib/locale';
import { UttilyBrand } from '@/components/brand';
import { LanguageDialog } from './language-dialog';
import styles from './home-navigation.module.css';

/** Public homepage navigation; transactional pages retain their own shell. */
export function HomeNavigation({
  locale = 'fr',
  sticky = true,
}: {
  locale?: AppLocale;
  sticky?: boolean;
}): React.JSX.Element {
  const fr = locale === 'fr';
  const homeHref = fr ? '/' : '/?lang=en';
  const [languageOpen, setLanguageOpen] = useState(false);
  const header = useRef<HTMLElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);

  function closeMenus(): void {
    if (menu.current) menu.current.open = false;
  }

  useEffect(() => {
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !header.current?.contains(event.target)) closeMenus();
    };
    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, []);

  function dismissWithEscape(event: React.KeyboardEvent<HTMLDetailsElement>): void {
    if (event.key === 'Escape' && event.currentTarget.open) {
      event.preventDefault();
      event.currentTarget.open = false;
      event.currentTarget.querySelector('summary')?.focus();
    }
  }

  return (
    <header ref={header} className={sticky ? styles.header : styles.headerStatic} lang={locale}>
      <a href="#home-heading" className={styles.skipLink}>
        {fr ? 'Aller au contenu' : 'Skip to content'}
      </a>
      <div className={styles.inner}>
        <UttilyBrand
          href={homeHref}
          ariaLabel={fr ? 'Uttily, accueil' : 'Uttily, home'}
          className={styles.brand}
          logoClassName={styles.brandLogo}
          onClick={closeMenus}
          priority
        />

        <LinkButton
          href="/onboarding/organization"
          variant="quiet"
          className={styles.host}
          onClick={closeMenus}
        >
          {fr ? 'Vous êtes loueur' : 'For rental partners'}
        </LinkButton>

        <div className={styles.utilities}>
          <Button
            type="button"
            variant="quiet"
            aria-label={fr ? 'Choisir la langue' : 'Choose language'}
            className={styles.languageTrigger}
            aria-haspopup="dialog"
            onClick={() => {
              closeMenus();
              setLanguageOpen(true);
            }}
          >
            <Icon name="globe" size={20} />
          </Button>
          <details ref={menu} className={styles.menu} onKeyDown={dismissWithEscape}>
            <summary
              className={styles.menuTrigger}
              aria-label={fr ? 'Menu principal' : 'Main menu'}
            >
              <Icon name="menu" size={20} />
              <span>{fr ? 'Mon espace' : 'My space'}</span>
            </summary>
            <div className={[styles.panel, styles.accountPanel].join(' ')}>
              <div className={styles.accountAccess}>
                <p className={styles.panelTitle}>
                  {fr ? 'Bienvenue chez Uttily' : 'Welcome to Uttily'}
                </p>
                <SignedOut>
                  <p className={styles.accountHint}>
                    {fr
                      ? 'Vos prochaines sorties commencent ici.'
                      : 'Your next adventure starts here.'}
                  </p>
                  <LinkButton
                    href={'/sign-in?redirect_url=' + encodeURIComponent(homeHref)}
                    className={styles.signIn}
                    onClick={closeMenus}
                  >
                    {fr ? 'Se connecter' : 'Sign in'}
                    <Icon name="arrow-right" size={17} />
                  </LinkButton>
                </SignedOut>
                <SignedIn>
                  <div className={styles.account}>
                    <UserButton afterSignOutUrl={homeHref} />
                    <span>{fr ? 'Gérer mon compte' : 'Manage my account'}</span>
                  </div>
                </SignedIn>
              </div>
              <nav
                className={styles.accountLinks}
                aria-label={fr ? 'Liens du compte' : 'Account links'}
              >
                <Link
                  href={'/' + locale + '/account/bookings'}
                  aria-label={fr ? 'Mon compte' : 'My account'}
                  onClick={closeMenus}
                >
                  <Icon name="calendar" size={19} />
                  {fr ? 'Mes locations' : 'My bookings'}
                </Link>
                <Link
                  href={'/' + locale + '/account/privacy'}
                  aria-label={fr ? 'Confidentialité et données' : 'Privacy and data'}
                  onClick={closeMenus}
                >
                  <Icon name="settings" size={19} />
                  {fr ? 'Confidentialité & données' : 'Privacy & data'}
                </Link>
                <Link href="/dashboard" onClick={closeMenus}>
                  <Icon name="home" size={19} />
                  {fr ? 'Espace professionnel' : 'Professional dashboard'}
                </Link>
              </nav>
            </div>
          </details>
        </div>
      </div>
      <LanguageDialog open={languageOpen} locale={locale} onClose={() => setLanguageOpen(false)} />
    </header>
  );
}
