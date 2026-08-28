import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSupportPlatformAdmin } from '@/lib/support-auth';
import { getOrganizationSupportDetails, SupportOrganizationNotFoundError } from '@uttily/core';
import { ResendInvitationButton } from './resend-invitation-button';
import styles from './organization-support.module.css';

export const dynamic = 'force-dynamic';

export default async function OrganizationSupportPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { db } = await requireSupportPlatformAdmin();
  const { orgId } = await params;

  let org;
  try {
    org = await getOrganizationSupportDetails(db, orgId);
  } catch (err) {
    if (err instanceof SupportOrganizationNotFoundError) {
      notFound();
    }
    throw err;
  }

  const isReady = org.readiness.isReadyForReservations;

  return (
    <div className={styles.container}>
      {/* Header 360 */}
      <div className={styles.headerCard}>
        <div className={styles.headerMain}>
          <Link
            href="/internal"
            style={{
              color: '#38bdf8',
              fontSize: '0.85rem',
              textDecoration: 'none',
              marginBottom: '0.5rem',
            }}
          >
            ← Retour à la recherche support
          </Link>
          <h1 className={styles.title}>
            <span>🏢</span> {org.legalName}
          </h1>
          <div className={styles.metaRow}>
            <span>
              <strong>Slug :</strong> <code>{org.slug}</code>
            </span>
            <span>•</span>
            <span>
              <strong>ID :</strong> <code>{org.id}</code>
            </span>
            <span>•</span>
            <span>
              <strong>Créé le :</strong> {org.createdAt.toLocaleDateString('fr-FR')}
            </span>
            <span>•</span>
            <Link
              href={`/dashboard/${org.id}`}
              target="_blank"
              style={{ color: '#38bdf8', textDecoration: 'underline', fontSize: '0.85rem' }}
            >
              Ouvrir l’espace Pro ↗
            </Link>
          </div>
        </div>

        <div>
          <span
            className={`${styles.readinessBadge} ${isReady ? styles.readySuccess : styles.readyWarning}`}
          >
            {isReady
              ? '✅ Prêt pour réservations'
              : `⚠️ Non prêt (${org.readiness.completedCount}/${org.readiness.totalCount} jalons)`}
          </span>
        </div>
      </div>

      {/* Alertes Support */}
      {(org.alerts.failedNotificationsCount > 0 || org.alerts.failedPaymentsCount > 0) && (
        <div className={styles.alertList}>
          {org.alerts.failedNotificationsCount > 0 && (
            <div className={styles.alertBanner}>
              <span>⚠️</span>
              <div>
                <strong>Notifications : </strong>
                {org.alerts.failedNotificationsCount} notification(s) transactionnelle(s) en échec
                pour cette organisation.
              </div>
            </div>
          )}
          {org.alerts.failedPaymentsCount > 0 && (
            <div className={styles.alertBanner}>
              <span>⚠️</span>
              <div>
                <strong>Paiements : </strong>
                {org.alerts.failedPaymentsCount} paiement(s) en échec nécessitant une attention
                support.
              </div>
            </div>
          )}
        </div>
      )}

      {/* Grille 2 colonnes */}
      <div className={styles.grid2Col}>
        {/* Onboarding & Stripe Connect */}
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>
            <span>💳 Diagnostic Paiements Stripe Connect</span>
          </h2>
          <div className={styles.infoGrid}>
            <div className={styles.infoLabel}>Compte Connect :</div>
            <div className={styles.infoVal}>
              <code>{org.paymentAccount?.providerAccountId ?? 'Aucun compte lié'}</code>
            </div>

            <div className={styles.infoLabel}>Statut Onboarding :</div>
            <div className={styles.infoVal}>
              {org.paymentAccount?.onboardingStatus ?? 'NON_CONFIGURÉ'}
            </div>

            <div className={styles.infoLabel}>Encaissement activé :</div>
            <div className={styles.infoVal}>
              {org.paymentAccount?.chargesEnabled ? '✅ Oui' : '❌ Non'}
            </div>

            <div className={styles.infoLabel}>Virements activés :</div>
            <div className={styles.infoVal}>
              {org.paymentAccount?.payoutsEnabled ? '✅ Oui' : '❌ Non'}
            </div>

            <div className={styles.infoLabel}>Capacité transferts :</div>
            <div className={styles.infoVal}>
              {org.paymentAccount?.transfersCapabilityStatus ?? '—'}
            </div>
          </div>

          <div
            style={{ marginTop: '0.5rem', borderTop: '1px solid #1f2937', paddingTop: '0.75rem' }}
          >
            <h3 style={{ fontSize: '0.9rem', color: '#94a3b8', marginBottom: '0.5rem' }}>
              Jalons d’Onboarding Pro ({org.readiness.percentage}%) :
            </h3>
            <ul
              style={{
                paddingLeft: '1.2rem',
                fontSize: '0.85rem',
                color: '#cbd5e1',
                lineHeight: '1.6',
              }}
            >
              {org.readiness.milestones.map((m) => (
                <li key={m.key}>
                  {m.key} : {m.completed ? '✅ Validé' : '❌ Incomplet'}
                  {m.details.info ? ` (${m.details.info})` : ''}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Flotte & Établissements */}
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>
            <span>🚲 Flotte & Établissements</span>
          </h2>
          <div className={styles.infoGrid}>
            <div className={styles.infoLabel}>Total vélos physiques :</div>
            <div className={styles.infoVal}>{org.inventoryOverview.total} exemplaire(s)</div>

            <div className={styles.infoLabel}>Disponibles / Actifs :</div>
            <div className={styles.infoVal}>{org.inventoryOverview.active} disponible(s)</div>

            <div className={styles.infoLabel}>En maintenance / Incidents :</div>
            <div className={styles.infoVal}>{org.openIncidents.openMaintenanceCount}</div>

            <div className={styles.infoLabel}>Signalements dommages :</div>
            <div className={styles.infoVal}>{org.openIncidents.damageReportsCount}</div>
          </div>

          <div
            style={{ marginTop: '0.5rem', borderTop: '1px solid #1f2937', paddingTop: '0.75rem' }}
          >
            <h3 style={{ fontSize: '0.9rem', color: '#94a3b8', marginBottom: '0.5rem' }}>
              Établissements ({org.locations.length})
            </h3>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.th}>Nom</th>
                    <th className={styles.th}>Ville</th>
                    <th className={styles.th}>Retrait</th>
                    <th className={styles.th}>Fuseau</th>
                  </tr>
                </thead>
                <tbody>
                  {org.locations.map((loc) => (
                    <tr key={loc.id}>
                      <td className={styles.td}>
                        <strong>{loc.name}</strong>
                      </td>
                      <td className={styles.td}>{loc.city ?? '—'}</td>
                      <td className={styles.td}>{loc.pickupEnabled ? '✅ Oui' : '❌ Non'}</td>
                      <td className={styles.td}>
                        <code>{loc.timeZone}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* Équipe & Invitations */}
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>
          <span>👥 Équipe & Invitations</span>
        </h2>
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th}>Type</th>
                <th className={styles.th}>Email</th>
                <th className={styles.th}>Nom</th>
                <th className={styles.th}>Rôle</th>
                <th className={styles.th}>Statut</th>
                <th className={styles.th}>Actions Support</th>
              </tr>
            </thead>
            <tbody>
              {org.members.map((m) => (
                <tr key={m.id}>
                  <td className={styles.td}>Membre</td>
                  <td className={styles.td}>
                    <strong>{m.email}</strong>
                  </td>
                  <td className={styles.td}>{m.displayName ?? '—'}</td>
                  <td className={styles.td}>
                    <code>{m.role}</code>
                  </td>
                  <td className={styles.td}>{m.status}</td>
                  <td className={styles.td}>—</td>
                </tr>
              ))}
              {org.pendingInvitations.map((inv) => (
                <tr key={inv.id} style={{ background: 'rgba(245, 158, 11, 0.04)' }}>
                  <td className={styles.td}>Invitation</td>
                  <td className={styles.td}>
                    <strong>{inv.email}</strong>
                  </td>
                  <td className={styles.td}>—</td>
                  <td className={styles.td}>
                    <code>{inv.role}</code>
                  </td>
                  <td className={styles.td}>
                    <span style={{ color: '#fbbf24' }}>
                      En attente (Expire: {inv.expiresAt.toLocaleDateString('fr-FR')})
                    </span>
                  </td>
                  <td className={styles.td}>
                    <ResendInvitationButton invitationId={inv.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Dernières réservations */}
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>
          <span>📋 Dernières Réservations ({org.recentBookings.length})</span>
        </h2>
        {org.recentBookings.length === 0 ? (
          <p style={{ color: '#64748b', fontSize: '0.9rem' }}>
            Aucune réservation trouvée pour cette organisation.
          </p>
        ) : (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>ID Réservation</th>
                  <th className={styles.th}>Client</th>
                  <th className={styles.th}>Statut</th>
                  <th className={styles.th}>Montant</th>
                  <th className={styles.th}>Date de création</th>
                  <th className={styles.th}>Action</th>
                </tr>
              </thead>
              <tbody>
                {org.recentBookings.map((b) => (
                  <tr key={b.id}>
                    <td className={styles.td}>
                      <code>{b.id.slice(0, 8)}...</code>
                    </td>
                    <td className={styles.td}>{b.customerEmail ?? 'N/A'}</td>
                    <td className={styles.td}>{b.status}</td>
                    <td className={styles.td}>
                      <strong>
                        {(b.totalAmountMinor / 100).toFixed(2)} {b.currency}
                      </strong>
                    </td>
                    <td className={styles.td}>{b.createdAt.toLocaleDateString('fr-FR')}</td>
                    <td className={styles.td}>
                      <Link
                        href={`/internal/bookings/${b.id}`}
                        style={{ color: '#38bdf8', textDecoration: 'none' }}
                      >
                        Diagnostic complet →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
