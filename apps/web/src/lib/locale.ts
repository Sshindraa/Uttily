export type AppLocale = 'fr' | 'en';

/** Déduit la langue d’une URL publique, avec le français comme fallback explicite. */
export function getLocaleFromPathname(pathname: string | null | undefined): AppLocale {
  return pathname?.split('/')[1] === 'en' ? 'en' : 'fr';
}

/** Retourne la locale Intl cohérente avec la langue de l’interface. */
export function getIntlLocale(locale: AppLocale | string): 'fr-FR' | 'en-GB' {
  return locale === 'en' ? 'en-GB' : 'fr-FR';
}
