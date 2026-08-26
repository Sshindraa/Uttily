/**
 * URL publique canonique de l'application.
 *
 * Cette valeur est une configuration d'environnement, jamais une valeur
 * déduite du navigateur. Elle est transmise au checkout uniquement après
 * validation afin que Stripe ne reçoive pas une URL locale codée en dur ou une
 * URL contrôlée par le client.
 */

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export class PublicAppUrlConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicAppUrlConfigurationError';
  }
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase()) || LOCAL_HOSTNAMES.has(normalized);
}

/**
 * Résout l'origine publique sans révéler la valeur configurée dans les
 * erreurs. En production, HTTPS et un hostname public sont obligatoires.
 * En développement/test, HTTP est autorisé uniquement sur la boucle locale.
 */
export function getPublicAppUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const rawValue = environment.PUBLIC_APP_URL;
  if (typeof rawValue !== 'string' || rawValue.trim() !== rawValue || rawValue.length === 0) {
    throw new PublicAppUrlConfigurationError(
      'PUBLIC_APP_URL est requise et doit être une URL publique absolue.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new PublicAppUrlConfigurationError(
      'PUBLIC_APP_URL est requise et doit être une URL publique absolue.',
    );
  }

  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    throw new PublicAppUrlConfigurationError('PUBLIC_APP_URL a une forme invalide.');
  }

  const isProductionLike =
    environment.NODE_ENV === 'production' || environment.STRIPE_ENVIRONMENT === 'LIVE';
  const isLocal = isLocalHostname(parsed.hostname);
  if (isProductionLike && (parsed.protocol !== 'https:' || isLocal)) {
    throw new PublicAppUrlConfigurationError(
      'PUBLIC_APP_URL doit utiliser HTTPS et un hostname public dans cet environnement.',
    );
  }
  if (!isProductionLike && parsed.protocol === 'http:' && !isLocal) {
    throw new PublicAppUrlConfigurationError(
      'PUBLIC_APP_URL en HTTP doit pointer vers la boucle locale.',
    );
  }

  return parsed.origin;
}
