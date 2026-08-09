import type { ConnectedAccountReadiness } from '@uttily/core';

/**
 * Affiche l'état de readiness du compte connecté Stripe sous forme de carte
 * avec des indicateurs visuels (vert = actif, rouge = inactif).
 *
 * Composant pur (server-safe) — aucune interaction.
 */
function Indicator({
  active,
  label,
  value,
}: {
  active: boolean;
  label: string;
  value: string;
}): React.ReactElement {
  return (
    <li style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0.25rem 0' }}>
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: '0.75rem',
          height: '0.75rem',
          borderRadius: '50%',
          backgroundColor: active ? '#16a34a' : '#dc2626',
          flexShrink: 0,
        }}
      />
      <span>
        <strong>{label}</strong> : {value}{' '}
        <span
          className="sr-only"
          style={{
            position: 'absolute',
            width: '1px',
            height: '1px',
            overflow: 'hidden',
            clip: 'rect(0 0 0 0)',
          }}
        >
          {active ? 'actif' : 'inactif'}
        </span>
      </span>
    </li>
  );
}

export function StatusCard({
  readiness,
}: {
  readiness: ConnectedAccountReadiness;
}): React.ReactElement {
  const transfersActive = readiness.transfersCapabilityStatus === 'active';

  return (
    <section
      aria-labelledby="status-card-title"
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: '0.5rem',
        padding: '1rem',
        marginTop: '1rem',
      }}
    >
      <h2 id="status-card-title">État du compte</h2>

      {readiness.notConfigured ? (
        <p role="status">Aucun compte Stripe Connect n'est configuré pour cette organisation.</p>
      ) : (
        <ul
          aria-label="Indicateurs de readiness"
          aria-live="polite"
          style={{ listStyle: 'none', padding: 0, margin: 0 }}
        >
          <Indicator
            active={readiness.ready}
            label="Prêt à encaisser"
            value={readiness.ready ? 'oui' : 'non'}
          />
          <Indicator
            active={readiness.chargesEnabled}
            label="Charges (encaissements)"
            value={readiness.chargesEnabled ? 'activées' : 'désactivées'}
          />
          <Indicator
            active={readiness.payoutsEnabled}
            label="Payouts (virements)"
            value={readiness.payoutsEnabled ? 'activés' : 'désactivés'}
          />
          <Indicator
            active={transfersActive}
            label="Transfers"
            value={readiness.transfersCapabilityStatus ?? 'inconnu'}
          />
        </ul>
      )}

      {readiness.providerAccountId && (
        <p style={{ marginTop: '0.75rem', fontSize: '0.875rem', color: '#6b7280' }}>
          Compte Stripe : <code>{readiness.providerAccountId}</code>
        </p>
      )}
    </section>
  );
}
