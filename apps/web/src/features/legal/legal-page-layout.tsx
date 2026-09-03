import type { ReactNode } from 'react';
import Link from 'next/link';
import { ClientShell } from '@/components/shells/client-shell';
import type { AppLocale } from '@/lib/locale';
import styles from './legal-page.module.css';

interface LegalPageLayoutProps {
  locale: AppLocale;
  slug: 'terms' | 'rental-terms' | 'pro-terms' | 'privacy' | 'legal';
  title: string;
  effectiveDate: string;
  version?: string;
  children: ReactNode;
}

export function LegalPageLayout({
  locale,
  slug,
  title,
  effectiveDate,
  version = 'v1',
  children,
}: LegalPageLayoutProps): React.ReactElement {
  const fr = locale === 'fr';
  const otherLocale = fr ? 'en' : 'fr';
  const alternateLabel = fr ? 'English' : 'Français';
  const alternateHref = `/${otherLocale}/${slug}`;

  return (
    <ClientShell
      localeOverride={locale}
      alternateHref={alternateHref}
      alternateLabel={alternateLabel}
    >
      <main className={styles.container}>
        <header className={styles.header}>
          <div className={styles.breadcrumb}>
            <Link href={`/${locale}/search`} className={styles.breadcrumbLink}>
              {fr ? 'Accueil' : 'Home'}
            </Link>
            {' · '}
            <span>{fr ? 'Informations légales' : 'Legal information'}</span>
          </div>
          <h1 className={styles.title}>{title}</h1>
          <div className={styles.meta}>
            <span className={styles.badge}>{fr ? `Version ${version}` : `Version ${version}`}</span>
            <span>
              {fr ? `Date d’effet : ${effectiveDate}` : `Effective date: ${effectiveDate}`}
            </span>
          </div>
        </header>

        <article className={styles.content}>{children}</article>

        <nav
          className={styles.navLinks}
          aria-label={fr ? 'Navigation entre documents légaux' : 'Legal documents navigation'}
        >
          <Link href={`/${locale}/terms`}>
            {fr ? 'Conditions d’utilisation' : 'Terms of Service'}
          </Link>
          <Link href={`/${locale}/rental-terms`}>
            {fr ? 'Conditions de location' : 'Rental Terms'}
          </Link>
          <Link href={`/${locale}/pro-terms`}>
            {fr ? 'Conditions Partenaires (Pro)' : 'Partner Terms (Pro)'}
          </Link>
          <Link href={`/${locale}/privacy`}>
            {fr ? 'Politique de confidentialité' : 'Privacy Policy'}
          </Link>
          <Link href={`/${locale}/legal`}>{fr ? 'Mentions légales' : 'Legal Notice'}</Link>
        </nav>
      </main>
    </ClientShell>
  );
}
