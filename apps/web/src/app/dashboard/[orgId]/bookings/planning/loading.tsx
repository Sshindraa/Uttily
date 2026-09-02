export default function PlanningLoading(): React.ReactElement {
  return (
    <main aria-busy="true" aria-live="polite">
      <h1>Chargement du planning · Loading planning</h1>
      <p>Les événements de la flotte sont en cours de chargement…</p>
    </main>
  );
}
