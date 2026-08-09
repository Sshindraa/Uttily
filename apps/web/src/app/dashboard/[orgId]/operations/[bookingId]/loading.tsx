export default function OperationsDetailLoading(): React.ReactElement {
  return (
    <main>
      <p>← Retour aux opérations</p>
      <h1>Chargement de la réservation…</h1>
      <p aria-live="polite">Récupération des détails…</p>
    </main>
  );
}
