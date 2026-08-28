/**
 * @uttily/core — LIVE Readiness — Variable Definitions (Chantier 20-A).
 *
 * Source centralisée unique définissant les variables d'environnement
 * nécessaires au passage LIVE. Aucun secret réel dans ce fichier.
 *
 * Ces définitions alimentent :
 * - `checkLiveReadiness()` pour la vérification programmatique
 * - `pnpm readiness:live` pour la vérification CLI non destructive
 */

/** Règle de validation pour une variable d'environnement. */
export interface LiveVariableRule {
  /** Nom de la variable d'environnement. */
  readonly name: string;
  /** Description courte (affichée dans le rapport, jamais la valeur). */
  readonly description: string;
  /** Préfixe attendu (ex: 'sk_live_'). */
  readonly prefixCheck?: string;
  /** Longueur minimale requise. */
  readonly minLength?: number;
  /** Valeur exacte requise (ex: 'true'). */
  readonly mustEqual?: string;
  /** La valeur doit être un entier strictement positif. */
  readonly mustBePositiveInt?: boolean;
  /** La valeur doit être une URL HTTPS. */
  readonly mustBeHttps?: boolean;
  /** La valeur doit être une URL HTTPS non locale. */
  readonly mustBePublicHttps?: boolean;
  /** La valeur doit être une URL PostgreSQL non locale. */
  readonly mustBeRemotePostgresUrl?: boolean;
}

/**
 * Variables REQUISES pour un déploiement LIVE.
 * Chaque entrée est vérifiée par `checkLiveReadiness()`.
 */
export const REQUIRED_LIVE_VARIABLES: readonly LiveVariableRule[] = [
  // --- Stripe ---
  {
    name: 'STRIPE_SECRET_KEY',
    description: 'Clé secrète Stripe LIVE',
    prefixCheck: 'sk_live_',
  },
  {
    name: 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
    description: 'Clé publishable Stripe LIVE',
    prefixCheck: 'pk_live_',
  },
  {
    name: 'STRIPE_ENVIRONMENT',
    description: 'Environnement Stripe explicite',
    mustEqual: 'LIVE',
  },
  {
    name: 'PAYMENTS_LIVE_ENABLED',
    description: 'Verrou LIVE activé (ADR-010 §4)',
    mustEqual: 'true',
  },
  {
    name: 'STRIPE_PLATFORM_WEBHOOK_SECRET',
    description: 'Secret webhook plateforme Stripe',
    minLength: 1,
  },
  {
    name: 'STRIPE_CONNECT_WEBHOOK_SECRET',
    description: 'Secret webhook Connect Stripe',
    minLength: 1,
  },
  {
    name: 'STRIPE_WEBHOOK_IP_ALLOWLIST',
    description: 'Allow-list IP webhooks Stripe (obligatoire en LIVE)',
    minLength: 1,
  },
  {
    name: 'STRIPE_WEBHOOK_RATE_LIMIT_VERIFIED',
    description: 'Attestation rate limiting edge configuré',
    mustEqual: 'true',
  },
  {
    name: 'PLATFORM_COMMISSION_RATE_BPS',
    description: 'Commission plateforme (points de base, > 0)',
    mustBePositiveInt: true,
  },

  // --- Base de données ---
  {
    name: 'DATABASE_URL',
    description: 'URL PostgreSQL (endpoint pooled)',
    minLength: 1,
    mustBeRemotePostgresUrl: true,
  },

  // --- Authentification ---
  {
    name: 'CLERK_SECRET_KEY',
    description: 'Clé secrète Clerk LIVE',
    prefixCheck: 'sk_live_',
  },
  {
    name: 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
    description: 'Clé publishable Clerk LIVE',
    prefixCheck: 'pk_live_',
  },
  {
    name: 'INVITATION_SECRET',
    description: 'Secret des invitations (min 32 octets)',
    minLength: 32,
  },

  // --- Cron & sécurité ---
  {
    name: 'CRON_SECRET',
    description: 'Secret des endpoints Vercel Cron',
    minLength: 32,
  },
  {
    name: 'PUBLIC_SEARCH_CURSOR_SECRET',
    description: 'Secret HMAC pagination recherche publique (min 32 octets)',
    minLength: 32,
  },

  // --- Application ---
  {
    name: 'PUBLIC_APP_URL',
    description: "URL publique HTTPS de l'application",
    mustBeHttps: true,
    mustBePublicHttps: true,
  },

  // --- Stockage R2 ---
  {
    name: 'R2_ACCOUNT_ID',
    description: 'Cloudflare Account ID pour R2',
    minLength: 1,
  },
  {
    name: 'R2_ACCESS_KEY_ID',
    description: "Clé d'accès R2",
    minLength: 1,
  },
  {
    name: 'R2_SECRET_ACCESS_KEY',
    description: "Secret d'accès R2",
    minLength: 1,
  },
  {
    name: 'R2_BUCKET_NAME',
    description: 'Nom du bucket R2 documents',
    minLength: 1,
  },

  // --- Email transactionnel ---
  {
    name: 'RESEND_API_KEY',
    description: 'Clé API Resend',
    prefixCheck: 're_',
  },
  {
    name: 'RESEND_FROM_EMAIL',
    description: "Adresse d'envoi email transactionnel",
    minLength: 1,
  },
  {
    name: 'RESEND_BOOKING_CONFIRMED_TEMPLATE_ID',
    description: 'ID template Resend booking confirmation (requis par le worker)',
    minLength: 1,
  },
] as const;

/**
 * Variables OPTIONNELLES pour un déploiement LIVE.
 * Leur absence ne bloque pas le passage LIVE.
 */
export const OPTIONAL_VARIABLES: readonly LiveVariableRule[] = [
  {
    name: 'DATABASE_DIRECT_URL',
    description: 'URL PostgreSQL directe (migrations uniquement)',
    minLength: 1,
  },
  {
    name: 'NEXT_PUBLIC_MAPTILER_API_KEY',
    description: 'Clé API MapTiler (affichage carte)',
    minLength: 1,
  },
  {
    name: 'R2_PHOTOS_BUCKET_NAME',
    description: 'Bucket R2 dédié photos (repli sur R2_BUCKET_NAME)',
    minLength: 1,
  },
  {
    name: 'SUPPORTED_STRIPE_COUNTRIES',
    description: 'Pays Stripe Connect supportés (validation serveur)',
    minLength: 1,
  },
  {
    name: 'PRODUCT_ANALYTICS_ENVIRONMENT',
    description: 'Environnement analytics first-party (PRODUCTION verrouillé)',
    minLength: 1,
  },
] as const;
