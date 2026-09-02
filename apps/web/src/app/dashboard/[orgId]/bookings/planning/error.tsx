'use client';

export default function PlanningError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  return (
    <main role="alert">
      <h1>Impossible de charger le planning · Calendar unavailable</h1>
      <p>Réessayez. Les données d’origine n’ont pas été modifiées.</p>
      <button type="button" onClick={reset}>
        Réessayer · Retry
      </button>
    </main>
  );
}
