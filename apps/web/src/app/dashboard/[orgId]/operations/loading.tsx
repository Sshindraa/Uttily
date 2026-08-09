// Loading skeleton pour la liste des opérations.
// Aucun contenu sensible — seulement des placeholders structurels.
export default function OperationsListLoading(): React.ReactElement {
  return (
    <main>
      <h1>Opérations</h1>
      <p aria-live="polite">Chargement des réservations…</p>
      <ul
        aria-hidden="true"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
          listStyle: 'none',
          padding: 0,
        }}
      >
        {[0, 1, 2].map((i) => (
          <li
            key={i}
            style={{
              border: '1px solid #e5e7eb',
              borderRadius: 8,
              padding: '1rem',
              minHeight: 120,
              background: '#f9fafb',
            }}
          >
            <div
              style={{
                height: '1.25rem',
                width: '60%',
                background: '#e5e7eb',
                borderRadius: 4,
                marginBottom: '0.5rem',
              }}
            />
            <div
              style={{
                height: '1rem',
                width: '40%',
                background: '#e5e7eb',
                borderRadius: 4,
                marginBottom: '0.25rem',
              }}
            />
            <div style={{ height: '1rem', width: '50%', background: '#e5e7eb', borderRadius: 4 }} />
          </li>
        ))}
      </ul>
    </main>
  );
}
