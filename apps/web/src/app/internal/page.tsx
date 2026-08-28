import Link from 'next/link';
import { requireSupportPlatformAdmin } from '@/lib/support-auth';
import { searchSupport, listAuditLogsSupport } from '@uttily/core';
import { SupportSearchForm } from './search-client';
import styles from './internal.module.css';

export const dynamic = 'force-dynamic';

export default async function InternalCockpitPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { db } = await requireSupportPlatformAdmin();
  const { q } = await searchParams;
  const rawQuery = q?.trim();

  const searchResults = rawQuery ? await searchSupport(db, rawQuery, { limit: 15 }) : null;
  const recentAudit = !rawQuery ? await listAuditLogsSupport(db, { limit: 8 }) : [];

  const getBadgeClass = (variant?: string) => {
    switch (variant) {
      case 'success':
        return styles.statusSuccess;
      case 'warning':
        return styles.statusWarning;
      case 'danger':
        return styles.statusError;
      default:
        return '';
    }
  };

  return (
    <div className={styles.container}>
      <section className={styles.hero}>
        <h1 className={styles.heroTitle}>Cockpit Support & Diagnostic</h1>
        <p className={styles.heroSubtitle}>
          Recherche multi-entités tolérante, audit complet et actions de support sécurisées.
        </p>
        <SupportSearchForm initialQuery={rawQuery ?? ''} />
      </section>

      {searchResults && (
        <div className={styles.resultsSection}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>
              Résultats de recherche pour{' '}
              <span style={{ color: '#38bdf8' }}>« {searchResults.query} »</span>
            </h2>
            <span className={styles.resultBadge}>{searchResults.totalMatches} résultat(s)</span>
          </div>

          {searchResults.totalMatches === 0 ? (
            <div className={styles.emptyState}>
              <p>Aucune entité trouvée pour cette recherche.</p>
              <p style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
                Essayez un identifiant UUID, un email client, un nom légal ou un identifiant Stripe.
              </p>
            </div>
          ) : (
            <>
              {/* Organisations */}
              {searchResults.byCategory.organizations.length > 0 && (
                <div>
                  <h3 style={{ fontSize: '1rem', color: '#94a3b8', marginBottom: '0.5rem' }}>
                    🏢 Organisations ({searchResults.byCategory.organizations.length})
                  </h3>
                  <div className={styles.tableWrapper}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th className={styles.th}>Titre / Nom</th>
                          <th className={styles.th}>Détails</th>
                          <th className={styles.th}>Statut</th>
                          <th className={styles.th}>ID</th>
                          <th className={styles.th}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {searchResults.byCategory.organizations.map((org) => (
                          <tr key={org.id} className={styles.tr}>
                            <td className={styles.td}>
                              <strong>{org.title}</strong>
                            </td>
                            <td className={styles.td}>{org.subtitle}</td>
                            <td className={styles.td}>
                              {org.badge && (
                                <span
                                  className={`${styles.statusTag} ${getBadgeClass(org.badge.variant)}`}
                                >
                                  {org.badge.label}
                                </span>
                              )}
                            </td>
                            <td className={styles.td}>
                              <code style={{ fontSize: '0.8rem' }}>{org.id}</code>
                            </td>
                            <td className={styles.td}>
                              <Link href={org.url} className={styles.link}>
                                Voir la fiche 360° →
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Réservations */}
              {searchResults.byCategory.bookings.length > 0 && (
                <div>
                  <h3 style={{ fontSize: '1rem', color: '#94a3b8', marginBottom: '0.5rem' }}>
                    📋 Réservations ({searchResults.byCategory.bookings.length})
                  </h3>
                  <div className={styles.tableWrapper}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th className={styles.th}>Réservation</th>
                          <th className={styles.th}>Détails</th>
                          <th className={styles.th}>Statut</th>
                          <th className={styles.th}>ID</th>
                          <th className={styles.th}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {searchResults.byCategory.bookings.map((b) => (
                          <tr key={b.id} className={styles.tr}>
                            <td className={styles.td}>
                              <strong>{b.title}</strong>
                            </td>
                            <td className={styles.td}>{b.subtitle}</td>
                            <td className={styles.td}>
                              {b.badge && (
                                <span
                                  className={`${styles.statusTag} ${getBadgeClass(b.badge.variant)}`}
                                >
                                  {b.badge.label}
                                </span>
                              )}
                            </td>
                            <td className={styles.td}>
                              <code>{b.id.slice(0, 8)}...</code>
                            </td>
                            <td className={styles.td}>
                              <Link href={b.url} className={styles.link}>
                                Voir le diagnostic →
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Paiements */}
              {searchResults.byCategory.payments.length > 0 && (
                <div>
                  <h3 style={{ fontSize: '1rem', color: '#94a3b8', marginBottom: '0.5rem' }}>
                    💳 Paiements ({searchResults.byCategory.payments.length})
                  </h3>
                  <div className={styles.tableWrapper}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th className={styles.th}>Paiement</th>
                          <th className={styles.th}>Détails</th>
                          <th className={styles.th}>Statut</th>
                          <th className={styles.th}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {searchResults.byCategory.payments.map((p) => (
                          <tr key={p.id} className={styles.tr}>
                            <td className={styles.td}>
                              <strong>{p.title}</strong>
                            </td>
                            <td className={styles.td}>{p.subtitle}</td>
                            <td className={styles.td}>
                              {p.badge && (
                                <span
                                  className={`${styles.statusTag} ${getBadgeClass(p.badge.variant)}`}
                                >
                                  {p.badge.label}
                                </span>
                              )}
                            </td>
                            <td className={styles.td}>
                              <Link href={p.url} className={styles.link}>
                                Voir paiements →
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Remboursements */}
              {searchResults.byCategory.refunds.length > 0 && (
                <div>
                  <h3 style={{ fontSize: '1rem', color: '#94a3b8', marginBottom: '0.5rem' }}>
                    💶 Remboursements ({searchResults.byCategory.refunds.length})
                  </h3>
                  <div className={styles.tableWrapper}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th className={styles.th}>Remboursement</th>
                          <th className={styles.th}>Détails</th>
                          <th className={styles.th}>Statut</th>
                          <th className={styles.th}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {searchResults.byCategory.refunds.map((r) => (
                          <tr key={r.id} className={styles.tr}>
                            <td className={styles.td}>
                              <strong>{r.title}</strong>
                            </td>
                            <td className={styles.td}>{r.subtitle}</td>
                            <td className={styles.td}>
                              {r.badge && (
                                <span
                                  className={`${styles.statusTag} ${getBadgeClass(r.badge.variant)}`}
                                >
                                  {r.badge.label}
                                </span>
                              )}
                            </td>
                            <td className={styles.td}>
                              <Link href={r.url} className={styles.link}>
                                Voir diagnostic →
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Utilisateurs */}
              {searchResults.byCategory.users.length > 0 && (
                <div>
                  <h3 style={{ fontSize: '1rem', color: '#94a3b8', marginBottom: '0.5rem' }}>
                    👤 Utilisateurs ({searchResults.byCategory.users.length})
                  </h3>
                  <div className={styles.tableWrapper}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th className={styles.th}>Utilisateur</th>
                          <th className={styles.th}>Email / Détails</th>
                          <th className={styles.th}>Type</th>
                          <th className={styles.th}>ID</th>
                        </tr>
                      </thead>
                      <tbody>
                        {searchResults.byCategory.users.map((u) => (
                          <tr key={u.id} className={styles.tr}>
                            <td className={styles.td}>
                              <strong>{u.title}</strong>
                            </td>
                            <td className={styles.td}>{u.subtitle}</td>
                            <td className={styles.td}>
                              {u.badge && (
                                <span
                                  className={`${styles.statusTag} ${getBadgeClass(u.badge.variant)}`}
                                >
                                  {u.badge.label}
                                </span>
                              )}
                            </td>
                            <td className={styles.td}>
                              <code>{u.id}</code>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Vue d'accueil par défaut si aucune recherche */}
      {!searchResults && (
        <div className={styles.resultsSection}>
          <div className={styles.statsGrid}>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>Accès Rapide</span>
              <Link
                href="/internal/payments"
                className={styles.link}
                style={{ fontSize: '1.1rem', fontWeight: 600 }}
              >
                💳 Diagnostics Paiements & Remboursements →
              </Link>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>Console</span>
              <Link
                href="/internal/notifications"
                className={styles.link}
                style={{ fontSize: '1.1rem', fontWeight: 600 }}
              >
                🔔 Traitement des Notifications Échouées →
              </Link>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>Conformité & Sécurité</span>
              <Link
                href="/internal/audit"
                className={styles.link}
                style={{ fontSize: '1.1rem', fontWeight: 600 }}
              >
                📜 Journal d’audit des actions support →
              </Link>
            </div>
          </div>

          <div style={{ marginTop: '1rem' }}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>📜 Dernières activités auditées</h2>
              <Link href="/internal/audit" className={styles.link}>
                Voir tout l’audit →
              </Link>
            </div>

            {recentAudit.length === 0 ? (
              <div className={styles.emptyState}>Aucun événement d’audit récent.</div>
            ) : (
              <div className={styles.tableWrapper}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th className={styles.th}>Date</th>
                      <th className={styles.th}>Action</th>
                      <th className={styles.th}>Cible</th>
                      <th className={styles.th}>Auteur</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentAudit.map((entry) => (
                      <tr key={entry.id} className={styles.tr}>
                        <td className={styles.td} style={{ fontSize: '0.85rem' }}>
                          {entry.createdAt.toLocaleString('fr-FR')}
                        </td>
                        <td className={styles.td}>
                          <span className={styles.statusTag}>{entry.action}</span>
                        </td>
                        <td className={styles.td}>
                          {entry.targetType ? `${entry.targetType} : ` : ''}
                          <code>{entry.targetId ?? 'N/A'}</code>
                        </td>
                        <td className={styles.td}>{entry.actorEmail ?? 'Système'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
