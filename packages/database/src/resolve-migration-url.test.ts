import { describe, it, expect } from 'vitest';
import { resolveMigrationUrl, MigrationUrlError } from './resolve-migration-url';

// Toutes les URLs de test sont fictives et ne contiennent aucun credential réel.
// Les sentinelles "supersecret", "password123", "SENTINEL_LEAK" sont volontaires
// pour vérifier la non-divulgation dans les messages d'erreur.

describe('resolveMigrationUrl', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Cas 1 : aucune variable → fallback local IPv4
  // ─────────────────────────────────────────────────────────────────────────
  it('retourne le fallback local IPv4 si aucune variable n est fournie', () => {
    const url = resolveMigrationUrl({ databaseUrl: '', databaseDirectUrl: '' });
    expect(url).toBe('postgresql://uttily:uttily@127.0.0.1:5432/uttily');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cas 2 : DATABASE_URL localhost → acceptée
  // ─────────────────────────────────────────────────────────────────────────
  it('accepte DATABASE_URL localhost sans DATABASE_DIRECT_URL', () => {
    const url = resolveMigrationUrl({
      databaseUrl: 'postgresql://u:p@localhost:5432/db',
    });
    expect(url).toBe('postgresql://u:p@localhost:5432/db');
  });

  it('accepte DATABASE_URL 127.0.0.1 sans DATABASE_DIRECT_URL', () => {
    const url = resolveMigrationUrl({
      databaseUrl: 'postgresql://u:p@127.0.0.1:5432/db',
    });
    expect(url).toBe('postgresql://u:p@127.0.0.1:5432/db');
  });

  it('accepte DATABASE_URL [::1] sans DATABASE_DIRECT_URL', () => {
    const url = resolveMigrationUrl({
      databaseUrl: 'postgresql://u:p@[::1]:5432/db',
    });
    expect(url).toBe('postgresql://u:p@[::1]:5432/db');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cas 3 : DATABASE_DIRECT_URL localhost → prioritaire sur DATABASE_URL
  // ─────────────────────────────────────────────────────────────────────────
  it('DATABASE_DIRECT_URL localhost est prioritaire sur DATABASE_URL', () => {
    const url = resolveMigrationUrl({
      databaseUrl: 'postgresql://u:p@localhost:5432/runtime',
      databaseDirectUrl: 'postgresql://u:p@localhost:5432/direct',
    });
    expect(url).toBe('postgresql://u:p@localhost:5432/direct');
  });

  it('DATABASE_DIRECT_URL localhost est acceptée même sans DATABASE_URL', () => {
    const url = resolveMigrationUrl({
      databaseDirectUrl: 'postgresql://u:p@localhost:5432/direct',
    });
    expect(url).toBe('postgresql://u:p@localhost:5432/direct');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cas 4 : DATABASE_URL Neon pooled distante sans direct → rejet
  // ─────────────────────────────────────────────────────────────────────────
  it('rejette DATABASE_URL Neon pooled distante sans DATABASE_DIRECT_URL', () => {
    expect(() =>
      resolveMigrationUrl({
        databaseUrl: 'postgresql://u:p@ep-cool-pooler-123.eu-central-1.aws.neon.tech/db',
      }),
    ).toThrow(MigrationUrlError);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cas 5 : DATABASE_URL Neon directe distante sans DATABASE_DIRECT_URL → rejet
  // ─────────────────────────────────────────────────────────────────────────
  it('rejette DATABASE_URL Neon directe distante sans DATABASE_DIRECT_URL', () => {
    expect(() =>
      resolveMigrationUrl({
        databaseUrl: 'postgresql://u:p@ep-cool-123.eu-central-1.aws.neon.tech/db',
      }),
    ).toThrow(MigrationUrlError);
  });

  it('rejette n importe quelle DATABASE_URL distante sans DATABASE_DIRECT_URL', () => {
    expect(() =>
      resolveMigrationUrl({
        databaseUrl: 'postgresql://u:p@db.example.com:5432/db',
      }),
    ).toThrow(MigrationUrlError);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cas 6 : DATABASE_DIRECT_URL Neon directe → acceptée
  // ─────────────────────────────────────────────────────────────────────────
  it('accepte DATABASE_DIRECT_URL Neon directe (sans -pooler)', () => {
    const url = resolveMigrationUrl({
      databaseDirectUrl: 'postgresql://u:p@ep-cool-123.eu-central-1.aws.neon.tech/db',
    });
    expect(url).toBe('postgresql://u:p@ep-cool-123.eu-central-1.aws.neon.tech/db');
  });

  it('accepte DATABASE_DIRECT_URL Neon directe même si DATABASE_URL est pooled', () => {
    const url = resolveMigrationUrl({
      databaseUrl: 'postgresql://u:p@ep-cool-pooler-123.eu-central-1.aws.neon.tech/db',
      databaseDirectUrl: 'postgresql://u:p@ep-cool-123.eu-central-1.aws.neon.tech/db',
    });
    expect(url).toBe('postgresql://u:p@ep-cool-123.eu-central-1.aws.neon.tech/db');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cas 7 : DATABASE_DIRECT_URL Neon pooled → rejet
  // ─────────────────────────────────────────────────────────────────────────
  it('rejette DATABASE_DIRECT_URL Neon pooled (hostname avec -pooler)', () => {
    expect(() =>
      resolveMigrationUrl({
        databaseDirectUrl: 'postgresql://u:p@ep-cool-pooler-123.eu-central-1.aws.neon.tech/db',
      }),
    ).toThrow(MigrationUrlError);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cas 8 : URL invalide → rejet
  // ─────────────────────────────────────────────────────────────────────────
  it('rejette une DATABASE_URL invalide', () => {
    expect(() => resolveMigrationUrl({ databaseUrl: 'not-a-url' })).toThrow(MigrationUrlError);
  });

  it('rejette une DATABASE_DIRECT_URL invalide', () => {
    expect(() => resolveMigrationUrl({ databaseDirectUrl: '://broken' })).toThrow(
      MigrationUrlError,
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cas 9 : validation du protocole — seuls postgres:// et postgresql://
  // ─────────────────────────────────────────────────────────────────────────
  it('rejette https:// comme DATABASE_URL', () => {
    expect(() =>
      resolveMigrationUrl({ databaseUrl: 'https://user:password@example.com/db' }),
    ).toThrow(MigrationUrlError);
  });

  it('rejette https:// comme DATABASE_DIRECT_URL', () => {
    expect(() =>
      resolveMigrationUrl({ databaseDirectUrl: 'https://user:password@example.com/db' }),
    ).toThrow(MigrationUrlError);
  });

  it('rejette mysql:// comme DATABASE_URL', () => {
    expect(() =>
      resolveMigrationUrl({ databaseUrl: 'mysql://user:password@example.com/db' }),
    ).toThrow(MigrationUrlError);
  });

  it('rejette http:// comme DATABASE_DIRECT_URL', () => {
    expect(() =>
      resolveMigrationUrl({ databaseDirectUrl: 'http://user:password@example.com/db' }),
    ).toThrow(MigrationUrlError);
  });

  it('rejette file:// comme DATABASE_URL', () => {
    expect(() => resolveMigrationUrl({ databaseUrl: 'file:///path/to/db' })).toThrow(
      MigrationUrlError,
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cas 10 : validation hostname et nom de base
  // ─────────────────────────────────────────────────────────────────────────
  it('rejette une URL PostgreSQL sans hostname', () => {
    expect(() => resolveMigrationUrl({ databaseUrl: 'postgresql:///db' })).toThrow(
      MigrationUrlError,
    );
  });

  it('rejette une URL PostgreSQL sans nom de base', () => {
    expect(() => resolveMigrationUrl({ databaseUrl: 'postgresql://u:p@localhost:5432' })).toThrow(
      MigrationUrlError,
    );
  });

  it('rejette une URL PostgreSQL avec pathname vide (slash seul)', () => {
    expect(() => resolveMigrationUrl({ databaseUrl: 'postgresql://u:p@localhost:5432/' })).toThrow(
      MigrationUrlError,
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cas 11 : protocoles valides — postgres:// et postgresql://
  // ─────────────────────────────────────────────────────────────────────────
  it('accepte postgres:// (protocole court) en local', () => {
    const url = resolveMigrationUrl({
      databaseUrl: 'postgres://u:p@localhost:5432/db',
    });
    expect(url).toBe('postgres://u:p@localhost:5432/db');
  });

  it('accepte postgresql:// (protocole long) en local', () => {
    const url = resolveMigrationUrl({
      databaseUrl: 'postgresql://u:p@localhost:5432/db',
    });
    expect(url).toBe('postgresql://u:p@localhost:5432/db');
  });

  it('accepte postgres:// comme DATABASE_DIRECT_URL distante directe', () => {
    const url = resolveMigrationUrl({
      databaseDirectUrl: 'postgres://u:p@ep-cool-123.eu-central-1.aws.neon.tech/db',
    });
    expect(url).toBe('postgres://u:p@ep-cool-123.eu-central-1.aws.neon.tech/db');
  });

  it('accepte postgresql:// comme DATABASE_DIRECT_URL Neon directe', () => {
    const url = resolveMigrationUrl({
      databaseDirectUrl: 'postgresql://u:p@ep-cool-123.eu-central-1.aws.neon.tech/db',
    });
    expect(url).toBe('postgresql://u:p@ep-cool-123.eu-central-1.aws.neon.tech/db');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cas 12 : non-divulgation — pattern correct (caught: unknown)
  // ─────────────────────────────────────────────────────────────────────────
  // Pattern obligatoire : variable caught déclarée avant le try, assignée
  // uniquement dans le catch, puis assertions APRÈS le bloc. Aucune
  // directive d'échec explicite placée dans le try (elle serait capturée
  // par le catch et rendrait le test faussement vert).

  it('message d erreur DATABASE_URL distante ne contient pas l URL ni les credentials', () => {
    let caught: unknown;
    try {
      resolveMigrationUrl({
        databaseUrl:
          'postgresql://supersecret:password123@ep-cool-pooler-123.eu-central-1.aws.neon.tech/db',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MigrationUrlError);
    const msg = (caught as Error).message;
    expect(msg).not.toContain('supersecret');
    expect(msg).not.toContain('password123');
    expect(msg).not.toContain('ep-cool-pooler-123');
    expect(msg).not.toContain('neon.tech');
  });

  it('message d erreur DATABASE_DIRECT_URL pooled ne contient pas l URL ni les credentials', () => {
    let caught: unknown;
    try {
      resolveMigrationUrl({
        databaseDirectUrl:
          'postgresql://supersecret:password123@ep-cool-pooler-123.eu-central-1.aws.neon.tech/db',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MigrationUrlError);
    const msg = (caught as Error).message;
    expect(msg).not.toContain('supersecret');
    expect(msg).not.toContain('password123');
    expect(msg).not.toContain('ep-cool-pooler-123');
    expect(msg).not.toContain('neon.tech');
  });

  it('message d erreur pour protocole invalide ne contient pas le protocole ni les credentials', () => {
    let caught: unknown;
    try {
      resolveMigrationUrl({
        databaseUrl: 'https://supersecret:password123@example.com/db',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MigrationUrlError);
    const msg = (caught as Error).message;
    expect(msg).not.toContain('supersecret');
    expect(msg).not.toContain('password123');
    expect(msg).not.toContain('example.com');
    expect(msg).not.toContain('https');
  });

  it('message d erreur pour URL non parsable ne contient pas la sentinelle', () => {
    let caught: unknown;
    try {
      resolveMigrationUrl({
        databaseUrl: 'SENTINEL_LEAK:not-a-valid-url',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MigrationUrlError);
    const msg = (caught as Error).message;
    expect(msg).not.toContain('SENTINEL_LEAK');
  });

  it('message d erreur pour URL sans nom de base ne contient pas l hostname', () => {
    let caught: unknown;
    try {
      resolveMigrationUrl({
        databaseUrl: 'postgresql://supersecret:password123@ep-secret-host.neon.tech',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MigrationUrlError);
    const msg = (caught as Error).message;
    expect(msg).not.toContain('supersecret');
    expect(msg).not.toContain('password123');
    expect(msg).not.toContain('ep-secret-host');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cas 13 : priorité DATABASE_DIRECT_URL sur DATABASE_URL
  // ─────────────────────────────────────────────────────────────────────────
  it('DATABASE_DIRECT_URL distante directe est prioritaire sur DATABASE_URL locale', () => {
    const url = resolveMigrationUrl({
      databaseUrl: 'postgresql://u:p@localhost:5432/runtime',
      databaseDirectUrl: 'postgresql://u:p@ep-cool-123.eu-central-1.aws.neon.tech/db',
    });
    expect(url).toBe('postgresql://u:p@ep-cool-123.eu-central-1.aws.neon.tech/db');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cas 14 : méta-vérification — aucun test de sécurité ne peut réussir
  // avec zéro assertion utile
  // ─────────────────────────────────────────────────────────────────────────
  it('un helper qui n échoue jamais ne peut pas faire passer un test de rejet', () => {
    // Ce test garantit que le pattern caught/expect(caught) détecte bien
    // l'absence d'erreur. Si resolveMigrationUrl ne levait pas, caught
    // resterait undefined et toBeInstanceOf échouerait.
    let caught: unknown;
    try {
      resolveMigrationUrl({
        databaseUrl: 'https://SENTINEL_NO_THROW@example.com/db',
      });
    } catch (e) {
      caught = e;
    }
    // Si aucune erreur n'était levée, caught serait undefined et ce test
    // échouerait — prouvant que le pattern détecte les faux positifs.
    expect(caught).toBeInstanceOf(MigrationUrlError);
  });
});
