import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireSupportPlatformAdmin } from '@/lib/support-auth';
import styles from './layout.module.css';

export default async function InternalLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  let adminContext;
  try {
    adminContext = await requireSupportPlatformAdmin();
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'UNAUTHENTICATED') {
      redirect('/sign-in');
    }
    // Fail-closed pour les utilisateurs non-admin Uttily
    return (
      <div
        style={{
          padding: '3rem 1.5rem',
          textAlign: 'center',
          background: '#0b0f19',
          minHeight: '100vh',
          color: '#f87171',
        }}
      >
        <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>⛔ Accès Interne Refusé</h1>
        <p style={{ color: '#94a3b8', maxWidth: '500px', margin: '0 auto 1.5rem' }}>
          Cette zone est strictement réservée à l’équipe support et administration interne d’Uttily.
        </p>
        <Link
          href="/dashboard"
          style={{
            display: 'inline-block',
            padding: '0.6rem 1.2rem',
            background: '#1e293b',
            color: '#38bdf8',
            borderRadius: '6px',
            textDecoration: 'none',
            fontWeight: 500,
          }}
        >
          Retourner à l’Espace Pro
        </Link>
      </div>
    );
  }

  const { user } = adminContext;

  return (
    <div className={styles.wrapper}>
      <header className={styles.topBar}>
        <div className={styles.topBarInner}>
          <div className={styles.brandGroup}>
            <Link href="/internal" className={styles.brandLogo}>
              <span style={{ fontSize: '1.25rem' }}>⚡</span> Uttily Support
            </Link>
            <span className={styles.adminBadge}>Admin Interne</span>
          </div>

          <div className={styles.userEmail}>
            <span>👤 {user.email}</span>
            <Link
              href="/dashboard"
              style={{
                marginLeft: '1rem',
                color: '#38bdf8',
                fontSize: '0.8rem',
                textDecoration: 'none',
                border: '1px solid #1e293b',
                padding: '0.25rem 0.6rem',
                borderRadius: '4px',
              }}
            >
              🏢 Aller au Dashboard Pro →
            </Link>
          </div>
        </div>

        <nav className={styles.navBar} aria-label="Navigation Support Interne">
          <div className={styles.navInner}>
            <Link href="/internal" className={styles.navLink}>
              🔍 Recherche globale
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
