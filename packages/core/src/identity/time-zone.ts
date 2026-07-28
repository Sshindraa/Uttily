/**
 * Validation des fuseaux IANA.
 * Utilise l'API native Intl.supportedValuesOf lorsque disponible.
 */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length === 0) return false;
  try {
    // Test pragmatique : Intl.DateTimeFormat lève si le fuseau est invalide.
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Liste des fuseaux supportés par l'environnement courant.
 * Utilisé pour la validation côté formulaire.
 */
export function supportedTimeZones(): string[] {
  try {
    const supported = (
      Intl as unknown as {
        supportedValuesOf?: (key: string) => string[];
      }
    ).supportedValuesOf;
    if (typeof supported === 'function') {
      return supported('timeZone');
    }
  } catch {
    // ignore
  }
  return ['Europe/Paris', 'UTC'];
}
