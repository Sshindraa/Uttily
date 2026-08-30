'use client';

import Link from 'next/link';
import { SignedIn, SignedOut, UserButton } from '@clerk/nextjs';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import type * as React from 'react';
import { Icon, LinkButton } from '@uttily/ui';
import { getLocaleFromPathname } from '@/lib/locale';
import styles from './client-shell.module.css';

export function ClientShell({
  children,
  localeOverride,
  alternateHref,
  alternateLabel,
  showAuthAction = true,
}: {
  children: ReactNode;
  localeOverride?: 'fr' | 'en';
  alternateHref?: string;
  alternateLabel?: string;
  showAuthAction?: boolean;
}): React.JSX.Element {
  const pathname = usePathname();
  const locale = localeOverride ?? getLocaleFromPathname(pathname);
  const fr = locale === 'fr';
  const searchHref = `/${locale}/search`;
  const bookingsHref = `/${locale}/account/bookings`;
  const signInHref = `/sign-in?redirect_url=${encodeURIComponent(pathname ?? '/')}`;

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link
            className={styles.brand}
            href={searchHref}
            aria-label={fr ? 'Uttily, accueil' : 'Uttily, home'}
          >
            <span className={styles.brandMark}>U</span>
            <span>Uttily</span>
          </Link>
          <nav aria-label={fr ? 'Navigation client' : 'Customer navigation'} className={styles.nav}>
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
      {children}
      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <span className={styles.footerBrand}>Uttily</span>
          <span>
            {fr ? 'Des équipements fiables, près de vous.' : 'Reliable equipment, near you.'}
          </span>
        </div>
      </footer>
    </div>
  );
}
