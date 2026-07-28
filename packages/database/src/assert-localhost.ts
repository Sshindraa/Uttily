/**
 * Valide que DATABASE_URL cible localhost avant toute création ou suppression
 * de base de test. Les tests d'intégration ne peuvent pas cibler une base
 * distante (staging/production) pour éviter des destructions accidentelles.
 *
 * `new URL().hostname` retourne `[::1]` avec crochets pour une URL IPv6.
 * On normalise en retirant les crochets pour comparer avec `::1`.
 */
export function assertLocalhost(databaseUrl: string): void {
  let host = new URL(databaseUrl).hostname;
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  const allowed = ['localhost', '127.0.0.1', '::1'];
  if (!allowed.includes(host)) {
    throw new Error(
      `Refus de DROP/CREATE DATABASE sur l'hôte '${host}'. ` +
        "Les tests d'intégration ne peuvent cibler que localhost, 127.0.0.1 ou ::1. " +
        'Vérifiez DATABASE_URL.',
    );
  }
}
