import Link from 'next/link';
import type { ReactNode } from 'react';
import type * as React from 'react';
import { Icon, LinkButton } from '@uttily/ui';
import styles from './client-shell.module.css';

export function ClientShell({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link className={styles.brand} href="/" aria-label="Uttily, accueil">
            <span className={styles.brandMark}>U</span>
            <span>Uttily</span>
          </Link>
          <nav aria-label="Navigation client" className={styles.nav}>
            <Link href="/fr/search" className={styles.navLink} aria-label="Trouver un équipement">
              <Icon name="search" size={18} />
              Trouver un équipement
            </Link>
            <Link href="/fr/account/bookings" className={styles.navLink}>
              Mes locations
            </Link>
            <LinkButton href="/sign-in" variant="secondary" size="sm">
              Se connecter
            </LinkButton>
          </nav>
        </div>
      </header>
      {children}
      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <span className={styles.footerBrand}>Uttily</span>
          <span>Des équipements fiables, près de vous.</span>
        </div>
      </footer>
    </div>
  );
}
