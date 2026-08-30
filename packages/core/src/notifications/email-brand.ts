import { getPublicAppUrl } from '../identity/public-app-url';

const DEFAULT_EMAIL_BRAND = {
  publicAppUrl: 'https://uttily.com',
  supportEmail: 'support@uttily.com',
} as const;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface EmailBrandConfig {
  readonly publicAppUrl: string;
  readonly supportEmail: string;
}

export class EmailBrandConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailBrandConfigurationError';
  }
}

/**
 * Résout les éléments de marque utilisés par tous les emails transactionnels.
 *
 * En développement/test, les valeurs historiques servent uniquement de
 * secours pour rendre les templates directement testables. En production ou
 * avec Stripe LIVE, l'URL publique et l'adresse support doivent être
 * explicitement configurées.
 */
export function getEmailBrandConfig(
  environment: NodeJS.ProcessEnv = process.env,
): EmailBrandConfig {
  const publicAppUrlConfigured =
    environment.PUBLIC_APP_URL !== undefined || environment.NEXT_PUBLIC_APP_URL !== undefined;
  const supportEmailRaw = environment.SUPPORT_EMAIL;
  const productionLike =
    environment.NODE_ENV === 'production' || environment.STRIPE_ENVIRONMENT === 'LIVE';

  if (productionLike && !publicAppUrlConfigured) {
    throw new EmailBrandConfigurationError(
      'PUBLIC_APP_URL est requise pour les emails transactionnels en production.',
    );
  }
  if (productionLike && (!supportEmailRaw || supportEmailRaw.trim() === '')) {
    throw new EmailBrandConfigurationError(
      'SUPPORT_EMAIL est requise pour les emails transactionnels en production.',
    );
  }

  const publicAppUrl = publicAppUrlConfigured
    ? getPublicAppUrl(environment)
    : DEFAULT_EMAIL_BRAND.publicAppUrl;
  const supportEmail = supportEmailRaw?.trim() || DEFAULT_EMAIL_BRAND.supportEmail;

  if (!EMAIL_PATTERN.test(supportEmail)) {
    throw new EmailBrandConfigurationError('SUPPORT_EMAIL doit contenir une adresse email valide.');
  }

  return { publicAppUrl, supportEmail };
}
