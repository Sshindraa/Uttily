/**
 * Résolution sûre de l'URL de connexion utilisée par Drizzle Kit pour les
 * migrations (ADR-004, G5G-C).
 *
 * Règles :
 * - priorité à DATABASE_DIRECT_URL (connexion directe, sans pooler) ;
 * - si DATABASE_DIRECT_URL est absente :
 *   - DATABASE_URL est acceptée uniquement si elle cible localhost, 127.0.0.1
 *     ou ::1 (développement local historique) ;
 *   - une DATABASE_URL distante sans DATABASE_DIRECT_URL est rejetée
 *     fail-closed (risque d'utiliser la connexion pooled pour les migrations) ;
 * - si DATABASE_DIRECT_URL est distante et contient un hostname Neon avec
 *   `-pooler`, la configuration est rejetée (les migrations doivent utiliser
 *   l'endpoint direct, pas le pooler) ;
 * - une URL invalide ou avec un protocole non PostgreSQL est rejetée ;
 * - les messages d'erreur ne contiennent JAMAIS l'URL, le mot de passe ou les
 *   credentials ;
 * - fallback local explicite uniquement si aucune variable n'est fournie
 *   (développement local historique).
 *
 * DATABASE_DIRECT_URL est réservée aux migrations et opérations administratives
 * explicites. L'application Web et le worker utilisent toujours DATABASE_URL
 * (connexion pooled côté Neon) en runtime distant. Les tests unitaires
 * n'utilisent aucune base. Les tests d'intégration PostgreSQL destructifs
 * utilisent uniquement PostgreSQL local (garde-fou `assertLocalhost` rejette
 * toute URL distante dans DATABASE_URL pendant les tests).
 */

const LOCAL_FALLBACK = 'postgresql://uttily:uttily@localhost:5432/uttily';

const LOCALHOST_HOSTS = ['localhost', '127.0.0.1', '::1'];

const ALLOWED_PROTOCOLS = ['postgres:', 'postgresql:'];

/**
 * Erreur de configuration de migration. Ne contient jamais d'URL, de mot de
 * passe ou de credentials.
 */
export class MigrationUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationUrlError';
  }
}

/**
 * Normalise le hostname d'une URL : retire les crochets autour d'une IPv6
 * (ex: `[::1]` → `::1`), conformément à `assert-localhost.ts`.
 */
function normalizeHostname(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/**
 * Détermine si un hostname est un hôte local autorisé pour le fallback.
 */
function isLocalhost(hostname: string): boolean {
  return LOCALHOST_HOSTS.includes(normalizeHostname(hostname));
}

/**
 * Détermine si un hostname ressemble à un endpoint Neon pooled (contient
 * `-pooler`). Les endpoints Neon directs ne contiennent pas `-pooler`.
 */
function isNeonPooledHost(hostname: string): boolean {
  return hostname.includes('-pooler');
}

/**
 * Valide qu'une URL est parsable, utilise un protocole PostgreSQL, possède un
 * hostname non vide et un nom de base non vide. Retourne l'objet URL.
 *
 * Lance MigrationUrlError si l'URL est invalide, utilise un mauvais protocole,
 * n'a pas d'hostname ou n'a pas de nom de base. Les messages d'erreur ne
 * contiennent jamais l'URL, le username, le mot de passe ou l'hostname sensible.
 */
function parseAndValidateUrl(url: string, varName: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MigrationUrlError(
      `${varName} n'est pas une URL valide. ` +
        'Vérifiez le format (postgresql://user:password@host:port/db). ' +
        "L'URL n'est pas affichée pour des raisons de sécurité.",
    );
  }

  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    throw new MigrationUrlError(
      `${varName} utilise un protocole non autorisé. ` +
        'Seuls les protocoles postgres:// et postgresql:// sont acceptés. ' +
        "Le protocole reçu n'est pas affiché pour des raisons de sécurité.",
    );
  }

  if (!parsed.hostname) {
    throw new MigrationUrlError(
      `${varName} ne contient pas d'hôte. ` +
        "Une URL PostgreSQL valide doit contenir un hostname (ex: localhost ou l'endpoint Neon).",
    );
  }

  // Le nom de base est le pathname sans le slash initial.
  // new URL('postgresql://u:p@host:5432/db').pathname === '/db'
  // new URL('postgresql://u:p@host:5432/').pathname === '/'
  // new URL('postgresql://u:p@host:5432').pathname === ''
  const dbName = parsed.pathname.replace(/^\//, '');
  if (!dbName) {
    throw new MigrationUrlError(
      `${varName} ne contient pas de nom de base. ` +
        'Une URL PostgreSQL valide doit contenir un nom de base (ex: /uttily).',
    );
  }

  return parsed;
}

/**
 * Options de résolution. Permet d'injecter des valeurs pour les tests sans
 * dépendre de process.env.
 */
export interface ResolveMigrationUrlOptions {
  readonly databaseUrl?: string;
  readonly databaseDirectUrl?: string;
}

/**
 * Résout l'URL de connexion à utiliser par Drizzle Kit pour les migrations.
 *
 * Algorithme :
 * 1. Si DATABASE_DIRECT_URL est définie :
 *    a. Parser, valider le protocole, l'hostname et le nom de base.
 *    b. Si l'hôte est local → accepter (migration locale explicite).
 *    c. Si l'hôte est distant et contient `-pooler` → rejeter (les migrations
 *       doivent utiliser l'endpoint direct).
 *    d. Sinon (hôte distant sans `-pooler`) → accepter.
 *    e. Retourner DATABASE_DIRECT_URL.
 * 2. Si DATABASE_DIRECT_URL est absente et DATABASE_URL est définie :
 *    a. Parser, valider le protocole, l'hostname et le nom de base.
 *    b. Si l'hôte est local → accepter (développement local historique).
 *    c. Si l'hôte est distant → rejeter fail-closed (DATABASE_URL distante
 *       sans DATABASE_DIRECT_URL = risque d'utiliser le pooler pour les
 *       migrations).
 *    d. Retourner DATABASE_URL.
 * 3. Si aucune variable n'est définie → retourner le fallback local explicite.
 *
 * @returns l'URL de migration résolue
 * @throws {MigrationUrlError} si la configuration est invalide ou dangereuse
 */
export function resolveMigrationUrl(options: ResolveMigrationUrlOptions = {}): string {
  const directUrl = options.databaseDirectUrl ?? process.env.DATABASE_DIRECT_URL;
  const runtimeUrl = options.databaseUrl ?? process.env.DATABASE_URL;

  // 1. DATABASE_DIRECT_URL a la priorité.
  if (directUrl) {
    const parsed = parseAndValidateUrl(directUrl, 'DATABASE_DIRECT_URL');
    const hostname = parsed.hostname;

    if (isNeonPooledHost(hostname)) {
      throw new MigrationUrlError(
        'DATABASE_DIRECT_URL cible un endpoint Neon pooled (hostname contenant ' +
          "`-pooler`). Les migrations doivent utiliser l'endpoint direct sans " +
          '`pooler. Utilisez l\'endpoint direct fourni par Neon (sans "-pooler" ' +
          'dans le hostname).',
      );
    }

    // Local ou distant sans -pooler : accepté.
    return directUrl;
  }

  // 2. DATABASE_URL seule (sans DATABASE_DIRECT_URL).
  if (runtimeUrl) {
    const parsed = parseAndValidateUrl(runtimeUrl, 'DATABASE_URL');
    const hostname = parsed.hostname;

    if (isLocalhost(hostname)) {
      // Développement local historique : DATABASE_URL locale sans
      // DATABASE_DIRECT_URL est acceptée.
      return runtimeUrl;
    }

    // DATABASE_URL distante sans DATABASE_DIRECT_URL : fail-closed.
    throw new MigrationUrlError(
      'DATABASE_URL cible un hôte distant mais DATABASE_DIRECT_URL n est pas ' +
        'définie. Les migrations doivent utiliser une connexion directe (sans ' +
        'pooler). Définissez DATABASE_DIRECT_URL avec l endpoint direct Neon ' +
        '(sans "-pooler" dans le hostname).',
    );
  }

  // 3. Aucune variable : fallback local explicite (développement local).
  return LOCAL_FALLBACK;
}
