import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getMembership, requireMembership, getOrganizationById } from '@uttily/core';
import Link from 'next/link';
import styles from './layout.module.css';

// Layout partagé de la section organisation.
// Authentifie l'utilisateur et vérifie la membership une seule fois
// pour toutes les pages enfants (défense en profondeur : les pages
// enfants peuvent refaire leurs propres vérifications).
export default async function OrganizationLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const user = await getAuthenticatedUser();
  if (!user) redirect('/sign-in');
  const db = getDb();
  const membership = await getMembership(db, orgId, user.id);
  requireMembership(membership, ['OWNER', 'ADMIN', 'MANAGER', 'STAFF']);
  const org = await getOrganizationById(db, orgId);

  return (
    <div className={styles.wrapper}>
      <header className={styles.topBar}>
        <div className={styles.topBarInner}>
          <div className={styles.brandOrg}>
            <Link href="/dashboard" className={styles.brandLogo}>
              <span>⚡</span> Uttily Pro
            </Link>
            <span className={styles.brandDivider}>/</span>
            <Link href={`/dashboard/${orgId}`} className={styles.orgSelector}>
              <span>🏢</span>
              <span>{org?.legalName ?? 'Organisation'}</span>
              <span className={styles.roleBadge}>{membership?.role}</span>
            </Link>
          </div>

          <div style={{ fontSize: '0.85rem', color: '#64748b' }}>{user.email}</div>
        </div>

        <nav className={styles.navBar} aria-label="Navigation principale">
          <div className={styles.navInner}>
            <Link href={`/dashboard/${orgId}`} className={styles.navLink}>
              🏠 Accueil
            </Link>
            <Link href={`/dashboard/${orgId}/bikes`} className={styles.navLink}>
              🚲 Mes vélos
            </Link>
            <Link href={`/dashboard/${orgId}/bookings`} className={styles.navLink}>
              📋 Réservations
            </Link>
            <Link href={`/dashboard/${orgId}/fleet`} className={styles.navLink}>
              🔧 Flotte
            </Link>
            <Link href={`/dashboard/${orgId}/locations`} className={styles.navLink}>
              📍 Établissements
            </Link>
            <Link href={`/dashboard/${orgId}/finances`} className={styles.navLink}>
              💰 Revenus
            </Link>
            <span className={styles.navSeparator} aria-hidden="true" />
            <Link href={`/dashboard/${orgId}/team`} className={styles.navLink}>
              👥 Équipe
            </Link>
            <Link href={`/dashboard/${orgId}/settings`} className={styles.navLink}>
              ⚙️ Paramètres
            </Link>
          </div>
        </nav>
      </header>

      <main className={styles.mainContent}>{children}</main>
    </div>
  );
}
