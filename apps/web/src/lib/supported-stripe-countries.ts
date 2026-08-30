export const STRIPE_SUPPORTED_COUNTRIES = [
  { code: 'FR', label: 'France (EUR)' },
  { code: 'BE', label: 'Belgique (EUR)' },
  { code: 'DE', label: 'Allemagne (EUR)' },
  { code: 'ES', label: 'Espagne (EUR)' },
  { code: 'IT', label: 'Italie (EUR)' },
  { code: 'NL', label: 'Pays-Bas (EUR)' },
] as const;

export const DEFAULT_STRIPE_COUNTRY = STRIPE_SUPPORTED_COUNTRIES[0].code;
