import type { PublicUiLocale } from '@/lib/public-search';

export function getPublicErrorMessage(code: string, locale: PublicUiLocale): string {
  const fr = locale === 'fr';
  if (code === 'INVALID_LOCAL_TIME') {
    return fr
      ? "L'heure choisie est ambiguë ou inexistante dans le fuseau du lieu."
      : 'The selected time is ambiguous or does not exist in the location time zone.';
  }
  if (code === 'DESTINATION_NOT_FOUND' || code === 'DESTINATION_INACTIVE') {
    return fr
      ? "Cette destination n'est plus disponible."
      : 'This destination is no longer available.';
  }
  if (code === 'INVALID_CURSOR') {
    return fr
      ? 'Ce lien de pagination est invalide ou expiré.'
      : 'This pagination link is invalid or expired.';
  }
  if (code === 'INVALID_INPUT') {
    return fr ? 'Les critères de recherche sont invalides.' : 'The search criteria are invalid.';
  }
  return fr
    ? 'La recherche est momentanément indisponible. Réessayez plus tard.'
    : 'Search is temporarily unavailable. Please try again later.';
}
