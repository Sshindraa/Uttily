import Link from 'next/link';
import { requireSupportPlatformAdmin } from '@/lib/support-auth';
import { listPaymentsSupport } from '@uttily/core';
import { ReconcilePaymentButton } from './reconcile-payment-button';
import styles from './payments-support.module.css';

export const dynamic = 'force-dynamic';

export default async function PaymentsSupportPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { db } = await requireSupportPlatformAdmin();
  const { status } = await searchParams;

  const validStatus =
    status === 'FAILED' || status === 'PENDING' || status === 'SUCCEEDED' ? status : undefined;
  const payments = await listPaymentsSupport(db, {
    status: validStatus,
    limit: 50,
  });

  const getStatusBadge = (st: string) => {
    switch (st) {
      case 'SUCCEEDED':
      case 'PAID':
        return `${styles.statusBadge} ${styles.statusSucceeded}`;
      case 'FAILED':
        return `${styles.statusBadge} ${styles.statusFailed}`;
      default:
        return `${styles.statusBadge} ${styles.statusPending}`;
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>💳 Diagnostic Paiements & Remboursements</h1>
        <p className={styles.subtitle}>
          Surveillance des flux financiers, PaymentIntents Stripe, échecs et forçage de
          réconciliation.
        </p>

        <div className={styles.filtersBar}>
          <span style={{ fontSize: '0.85rem', color: '#94a3b8' }}>Filtrer par statut :</span>
          <Link
            href="/internal/payments"
            className={`${styles.filterLink} ${!validStatus ? styles.filterLinkActive : ''}`}
          >
            Tous
          </Link>
          <Link
            href="/internal/payments?status=FAILED"
            className={`${styles.filterLink} ${validStatus === 'FAILED' ? styles.filterLinkActive : ''}`}
          >
            ❌ En échec
          </Link>
          <Link
            href="/internal/payments?status=PENDING"
            className={`${styles.filterLink} ${validStatus === 'PENDING' ? styles.filterLinkActive : ''}`}
          >
            ⏳ En attente
          </Link>
          <Link
            href="/internal/payments?status=SUCCEEDED"
            className={`${styles.filterLink} ${validStatus === 'SUCCEEDED' ? styles.filterLinkActive : ''}`}
          >
            ✅ Réussis
          </Link>
        </div>
      </div>

      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th}>Date</th>
              <th className={styles.th}>ID Paiement</th>
              <th className={styles.th}>Organisation</th>
              <th className={styles.th}>Client</th>
              <th className={styles.th}>Stripe Intent</th>
              <th className={styles.th}>Statut</th>
              <th className={styles.th}>Montant</th>
              <th className={styles.th}>Erreur</th>
              <th className={styles.th}>Action Support</th>
            </tr>
          </thead>
          <tbody>
            {payments.length === 0 ? (
              <tr>
                <td colSpan={9} style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>
                  Aucun paiement trouvé pour ce filtre.
                </td>
              </tr>
            ) : (
              payments.map((p) => (
                <tr key={p.id}>
                  <td className={styles.td} style={{ fontSize: '0.8rem' }}>
                    {p.createdAt.toLocaleString('fr-FR')}
                  </td>
                  <td className={styles.td}>
                    {p.bookingId ? (
                      <Link href={`/internal/bookings/${p.bookingId}`} style={{ color: '#38bdf8' }}>
                        <code>{p.id.slice(0, 8)}...</code>
                      </Link>
                    ) : (
                      <code>{p.id.slice(0, 8)}...</code>
                    )}
                  </td>
                  <td className={styles.td}>
                    <Link
                      href={`/internal/organizations/${p.organizationId}`}
                      style={{ color: '#cbd5e1' }}
                    >
                      {p.organizationName}
                    </Link>
                  </td>
                  <td className={styles.td}>{p.customerEmail ?? '—'}</td>
                  <td className={styles.td}>
                    <code>{p.providerPaymentIntentId ?? '—'}</code>
                  </td>
                  <td className={styles.td}>
                    <span className={getStatusBadge(p.status)}>{p.status}</span>
                  </td>
                  <td className={styles.td}>
                    <strong>
                      {(p.amountMinor / 100).toFixed(2)} {p.currency}
                    </strong>
                  </td>
                  <td className={styles.td} style={{ color: p.lastError ? '#f87171' : '#64748b' }}>
                    {p.lastError ?? '—'}
                  </td>
                  <td className={styles.td}>
                    {p.status !== 'SUCCEEDED' && <ReconcilePaymentButton paymentId={p.id} />}
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
