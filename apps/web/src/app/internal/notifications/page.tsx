import Link from 'next/link';
import { requireSupportPlatformAdmin } from '@/lib/support-auth';
import { listNotificationsSupport } from '@uttily/core';
import { NotificationActionButtons } from './notifications-client';
import styles from './notifications-support.module.css';

export const dynamic = 'force-dynamic';

export default async function NotificationsSupportPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { db } = await requireSupportPlatformAdmin();
  const { status } = await searchParams;

  const validStatus =
    status === 'FAILED' || status === 'PENDING' || status === 'SENT' || status === 'CANCELLED'
      ? status
      : undefined;

  const notifs = await listNotificationsSupport(db, {
    status: validStatus,
    limit: 50,
  });

  const getStatusBadge = (st: string) => {
    switch (st) {
      case 'SENT':
        return `${styles.statusBadge} ${styles.statusSent}`;
      case 'FAILED':
        return `${styles.statusBadge} ${styles.statusFailed}`;
      case 'CANCELLED':
        return `${styles.statusBadge} ${styles.statusCancelled}`;
      default:
        return `${styles.statusBadge} ${styles.statusPending}`;
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>🔔 Console Notifications & Invitations</h1>
        <p className={styles.subtitle}>
          Supervision des emails transactionnels, relances sécurisées sans fuite de secrets et diagnostics d’erreurs.
        </p>

        <div className={styles.filtersBar}>
          <span style={{ fontSize: '0.85rem', color: '#94a3b8' }}>Filtrer par statut :</span>
          <Link
            href="/internal/notifications"
            className={`${styles.filterLink} ${!validStatus ? styles.filterLinkActive : ''}`}
          >
            Toutes
          </Link>
          <Link
            href="/internal/notifications?status=FAILED"
            className={`${styles.filterLink} ${validStatus === 'FAILED' ? styles.filterLinkActive : ''}`}
          >
            ❌ En échec
          </Link>
          <Link
            href="/internal/notifications?status=PENDING"
            className={`${styles.filterLink} ${validStatus === 'PENDING' ? styles.filterLinkActive : ''}`}
          >
            ⏳ En attente
          </Link>
          <Link
            href="/internal/notifications?status=SENT"
            className={`${styles.filterLink} ${validStatus === 'SENT' ? styles.filterLinkActive : ''}`}
          >
            ✅ Envoyées
          </Link>
          <Link
            href="/internal/notifications?status=CANCELLED"
            className={`${styles.filterLink} ${validStatus === 'CANCELLED' ? styles.filterLinkActive : ''}`}
          >
            🚫 Annulées
          </Link>
        </div>
      </div>

      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th}>Date programmée</th>
              <th className={styles.th}>Template</th>
              <th className={styles.th}>Destinataire</th>
              <th className={styles.th}>Organisation</th>
              <th className={styles.th}>Réservation</th>
              <th className={styles.th}>Statut</th>
              <th className={styles.th}>Tentatives</th>
              <th className={styles.th}>Erreur</th>
              <th className={styles.th}>Actions Support</th>
            </tr>
          </thead>
          <tbody>
            {notifs.length === 0 ? (
              <tr>
                <td colSpan={9} style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>
                  Aucune notification trouvée pour ce filtre.
                </td>
              </tr>
            ) : (
              notifs.map((n) => (
                <tr key={n.id}>
                  <td className={styles.td} style={{ fontSize: '0.8rem' }}>
                    {n.scheduledFor.toLocaleString('fr-FR')}
                  </td>
                  <td className={styles.td}>
                    <code>{n.template}</code>
                  </td>
                  <td className={styles.td}>
                    <strong>{n.recipient}</strong>
                  </td>
                  <td className={styles.td}>
                    {n.organizationId ? (
                      <Link href={`/internal/organizations/${n.organizationId}`} style={{ color: '#cbd5e1' }}>
                        {n.organizationName ?? 'Organisation'}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className={styles.td}>
                    {n.bookingId ? (
                      <Link href={`/internal/bookings/${n.bookingId}`} style={{ color: '#38bdf8' }}>
                        <code>{n.bookingId.slice(0, 8)}...</code>
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className={styles.td}>
                    <span className={getStatusBadge(n.status)}>{n.status}</span>
                  </td>
                  <td className={styles.td}>{n.attemptCount}</td>
                  <td className={styles.td} style={{ color: n.failureCode ? '#f87171' : '#64748b' }}>
                    {n.failureCode ?? '—'}
                    {n.requiresManualReview && (
                      <div style={{ marginTop: '0.2rem' }}>
                        <span className={styles.statusError} style={{ fontSize: '0.7rem' }}>
                          ⚠️ Revue requise
                        </span>
                      </div>
                    )}
                  </td>
                  <td className={styles.td}>
                    <NotificationActionButtons
                      notificationId={n.id}
                      status={n.status}
                      failureCode={n.failureCode}
                      requiresManualReview={n.requiresManualReview}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
