'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import type * as React from 'react';
import { getLocaleFromPathname } from '@/lib/locale';
import { HomeNavigation } from './home-navigation';
import styles from './client-shell.module.css';

export function ClientShell({
  children,
  localeOverride,
  alternateHref,
  alternateLabel: _alternateLabel,
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

  return (
    <div className={styles.shell}>
      {header ?? (
        <HomeNavigation
          locale={locale}
          sticky={false}
          alternateHref={alternateHref}
          signInRedirectUrl={pathname ?? undefined}
          showAuthAction={showAuthAction}
        />
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
