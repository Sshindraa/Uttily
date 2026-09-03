'use client';

import Link from 'next/link';
import { SignedIn, SignedOut, UserButton } from '@clerk/nextjs';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import type * as React from 'react';
import { Icon, LinkButton } from '@uttily/ui';
import { getLocaleFromPathname } from '@/lib/locale';
import { UttilyBrand } from '@/components/brand';
import styles from './client-shell.module.css';

export function ClientShell({
  children,
  localeOverride,
  alternateHref,
  alternateLabel,
  showAuthAction = true,
  header,
}: {
  children: ReactNode;
  localeOverride?: 'fr' | 'en';
  alternateHref?: string;
  alternateLabel?: string;
  showAuthAction?: boolean;
  header?: ReactNode;
}): React.JSX.Element {
  const pathname = usePathname();
  const locale = localeOverride ?? getLocaleFromPathname(pathname);
  const fr = locale === 'fr';
  const searchHref = `/${locale}/search`;
  const bookingsHref = `/${locale}/account/bookings`;
  const signInHref = `/sign-in?redirect_url=${encodeURIComponent(pathname ?? '/')}`;

  return (
    <div className={styles.shell}>
      {header ?? (
        <header className={styles.header}>
          <div className={styles.headerInner}>
            <UttilyBrand
              className={styles.brand}
              href={searchHref}
              ariaLabel={fr ? 'Uttily, accueil' : 'Uttily, home'}
              logoClassName={styles.brandLogo}
            />
            <nav
              aria-label={fr ? 'Navigation client' : 'Customer navigation'}
              className={styles.nav}
            >
              <Link
                href={searchHref}
                className={styles.navLink}
                aria-label={fr ? 'Trouver un équipement' : 'Find equipment'}
              >
                <Icon name="search" size={18} />
                {fr ? 'Trouver un équipement' : 'Find equipment'}
              </Link>
              <Link href={bookingsHref} className={styles.navLink}>
                {fr ? 'Mes locations' : 'My bookings'}
              </Link>
              {alternateHref && alternateLabel ? (
                <Link href={alternateHref} className={styles.navLink}>
                  {alternateLabel}
                </Link>
              ) : null}
              {showAuthAction ? (
                <SignedOut>
                  <LinkButton href={signInHref} variant="secondary" size="sm">
                    {fr ? 'Se connecter' : 'Sign in'}
                  </LinkButton>
                </SignedOut>
              ) : null}
              <SignedIn>
                <UserButton afterSignOutUrl={searchHref} />
              </SignedIn>
            </nav>
          </div>
        </header>
      )}
      {children}
      <footer className={styles.footer} lang={locale}>
        <div className={styles.footerInner}>
          <div className={styles.footerBrandGroup}>
            <span className={styles.footerBrand}>Uttily</span>
            <span>
              {fr ? 'Des équipements fiables, près de vous.' : 'Reliable equipment, near you.'}
            </span>
          </div>
          <nav aria-label={fr ? 'Liens légaux' : 'Legal links'} className={styles.footerLegalLinks}>
            <Link href={`/${locale}/terms`} className={styles.footerLegalLink}>
              {fr ? 'Conditions d’utilisation' : 'Terms of Service'}
            </Link>
            <Link href={`/${locale}/rental-terms`} className={styles.footerLegalLink}>
              {fr ? 'Conditions de location' : 'Rental Terms'}
            </Link>
            <Link href={`/${locale}/pro-terms`} className={styles.footerLegalLink}>
              {fr ? 'Conditions Pro' : 'Partner Terms'}
            </Link>
            <Link href={`/${locale}/privacy`} className={styles.footerLegalLink}>
              {fr ? 'Confidentialité' : 'Privacy'}
            </Link>
            <Link href={`/${locale}/legal`} className={styles.footerLegalLink}>
              {fr ? 'Mentions légales' : 'Legal Notice'}
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
