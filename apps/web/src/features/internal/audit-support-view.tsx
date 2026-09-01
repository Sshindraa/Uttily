import type { AuditLogSupportListItem } from '@uttily/core';
import styles from './audit-support.module.css';

export interface AuditSupportViewProps {
  logs: readonly AuditLogSupportListItem[];
}

export function AuditSupportView({ logs }: AuditSupportViewProps) {
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>📜 Journal d’Audit Append-Only</h1>
        <p className={styles.subtitle}>
          Traçabilité intégrale de toutes les mutations, interventions support et événements
          critiques de la plateforme.
        </p>
      </div>

      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th}>Date & Heure</th>
              <th className={styles.th}>Action</th>
              <th className={styles.th}>Auteur</th>
              <th className={styles.th}>Type & Cible</th>
              <th className={styles.th}>Métadonnées & Motif</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  style={{
                    padding: '2rem',
                    textAlign: 'center',
                    color: 'var(--ut-color-support-subtle)',
                  }}
                >
                  Aucun événement d’audit trouvé.
                </td>
              </tr>
            ) : (
              logs.map((log) => (
                <tr key={log.id}>
                  <td className={styles.td} style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                    {log.createdAt.toLocaleString('fr-FR')}
                  </td>
                  <td className={styles.td}>
                    <span className={styles.actionBadge}>{log.action}</span>
                  </td>
                  <td className={styles.td}>
                    {log.actorEmail ? <strong>{log.actorEmail}</strong> : <em>Système</em>}
                  </td>
                  <td className={styles.td}>
                    {log.targetType ? `${log.targetType} : ` : ''}
                    <code>{log.targetId ?? '—'}</code>
                  </td>
                  <td className={styles.td} style={{ maxWidth: '450px' }}>
                    {log.metadata ? (
                      <pre
                        style={{
                          margin: 0,
                          fontSize: '0.75rem',
                          color: 'var(--ut-color-support-muted)',
                          overflowX: 'auto',
                        }}
                      >
                        {JSON.stringify(log.metadata, null, 2)}
                      </pre>
                    ) : (
                      '—'
                    )}
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
