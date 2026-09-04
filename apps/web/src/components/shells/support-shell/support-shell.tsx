import Link from 'next/link';
import type { ReactNode } from 'react';
import { UttilyBrand } from '@/components/brand';
import styles from './support-shell.module.css';

type SupportShellProps = {
  children?: ReactNode;
  userEmail?: string;
  accessDenied?: boolean;
};

export function SupportShell({
  children,
  userEmail,
  accessDenied = false,
}: SupportShellProps): React.ReactElement {
  if (accessDenied) {
    return (
      <div className={styles.deniedState}>
        <h1>⛔ Accès Interne Refusé</h1>
        <p>
          Cette zone est strictement réservée à l’équipe support et administration interne d’Uttily.
        </p>
        <Link href="/dashboard">Retourner à l’Espace Pro</Link>
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <header className={styles.topBar}>
        <div className={styles.topBarInner}>
          <div className={styles.brandGroup}>
            <UttilyBrand
              href="/internal"
              ariaLabel="Uttily Support, accueil"
              className={styles.brandLogo}
              logoClassName={styles.brandSymbol}
              suffix="Support"
            />
            <span className={styles.adminBadge}>Admin Interne</span>
          </div>

          {userEmail ? (
            <div className={styles.userEmail}>
              <span>👤 {userEmail}</span>
              <Link href="/dashboard" className={styles.dashboardLink}>
                🏢 Aller au Dashboard Pro →
              </Link>
            </div>
          ) : null}
        </div>

        <nav className={styles.navBar} aria-label="Navigation Support Interne">
          <div className={styles.navInner}>
            <Link href="/internal" className={styles.navLink}>
              🔍 Recherche globale
            </Link>
            <Link href="/internal/health" className={styles.navLink}>
              🩺 Santé opérationnelle
            </Link>
            <Link href="/internal/payments" className={styles.navLink}>
              💳 Paiements & Remboursements
            </Link>
            <Link href="/internal/notifications" className={styles.navLink}>
              🔔 Notifications & Invitations
            </Link>
            <Link href="/internal/audit" className={styles.navLink}>
              📜 Journal d’audit
            </Link>
            <Link href="/internal/privacy" className={styles.navLink}>
              🛡️ Données & Privacy
            </Link>
            <Link href="/internal/analytics" className={styles.navLink}>
              📊 Funnel produit
            </Link>
          </div>
        </nav>
      </header>

      <main className={styles.mainContent}>{children}</main>

      <footer className={styles.footer}>
        <p>Uttily Back-office Support Interne V1 — Accès et actions sécurisés & audités.</p>
      </footer>
    </div>
  );
}
