import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProductAnalyticsError } from '@uttily/core';
import * as dbMod from '@/lib/db';
import * as maintenance from '@/lib/product-analytics-maintenance';
import { GET } from './route';

/**
 * Chantier 18-A — Contrat HTTP du cron /api/cron/process-product-analytics.
 *
 * Couvre : authentification fail-closed, invariant PRODUCTION, bornage des
 * erreurs de maintenance et fermeture de la réponse. Les invariants
 * agrégation/purge sur PostgreSQL réel sont couverts par
 * `product-analytics-maintenance.integration.test.ts`.
 */

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/product-analytics-maintenance', () => ({
  runProductAnalyticsMaintenance: vi.fn(),
}));

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

function successResult() {
  return {
    window: { fromDay: '2026-08-26', toDayExclusive: '2026-08-29' },
    collectionEnvironment: 'DEVELOPMENT' as const,
    productionCollectionEnabled: false as const,
    aggregatedEnvironments: [
      'DEVELOPMENT',
      'TEST',
    ] as maintenance.MaintenanceAnalyticsEnvironment[],
    aggregationDaysProcessed: 6,
    purge: { rawEventsDeleted: 3, aggregatesDeleted: 1 },
  };
}

function requestWith(authHeader?: string): Request {
  const headers = new Headers();
  if (authHeader !== undefined) headers.set('Authorization', authHeader);
  return new Request('https://uttily.test/api/cron/process-product-analytics', {
    method: 'GET',
    headers,
  });
}

describe('18-A — cron process-product-analytics : authentification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(maintenance.runProductAnalyticsMaintenance).mockResolvedValue(successResult());
  });

  afterEach(() => {
    if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  });

  it('refuse 401 quand CRON_SECRET est absent (fail-closed)', async () => {
    delete process.env.CRON_SECRET;

    const response = await GET(requestWith('Bearer anything'));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(maintenance.runProductAnalyticsMaintenance).not.toHaveBeenCalled();
  });

  it('refuse 401 quand CRON_SECRET est vide (fail-closed)', async () => {
    process.env.CRON_SECRET = '';

    const response = await GET(requestWith('Bearer '));

    expect(response.status).toBe(401);
    expect(maintenance.runProductAnalyticsMaintenance).not.toHaveBeenCalled();
  });

  it('refuse 401 sans en-tête Authorization', async () => {
    process.env.CRON_SECRET = 'secret-valide';

    const response = await GET(requestWith());

    expect(response.status).toBe(401);
  });

  it('refuse 401 avec un secret incorrect', async () => {
    process.env.CRON_SECRET = 'secret-valide';

    const response = await GET(requestWith('Bearer secret-incorrect'));

    expect(response.status).toBe(401);
    expect(maintenance.runProductAnalyticsMaintenance).not.toHaveBeenCalled();
  });

  it('refuse 401 avec un schéma d’autorisation non Bearer', async () => {
    process.env.CRON_SECRET = 'secret-valide';

    const response = await GET(requestWith('Basic secret-valide'));

    expect(response.status).toBe(401);
  });

  it('autorise 200 avec le secret exact', async () => {
    process.env.CRON_SECRET = 'secret-valide';

    const response = await GET(requestWith('Bearer secret-valide'));

    expect(response.status).toBe(200);
    expect(maintenance.runProductAnalyticsMaintenance).toHaveBeenCalledTimes(1);
  });
});

describe('18-A — cron process-product-analytics : contrat de réponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = 'secret-valide';
    vi.mocked(maintenance.runProductAnalyticsMaintenance).mockResolvedValue(successResult());
  });

  it('retourne des compteurs utiles et déterministes', async () => {
    const response = await GET(requestWith('Bearer secret-valide'));
    const body = await response.json();

    expect(body.ok).toBe(true);
    expect(body.window).toEqual({ fromDay: '2026-08-26', toDayExclusive: '2026-08-29' });
    expect(body.aggregationDaysProcessed).toBe(6);
    expect(body.purge).toEqual({ rawEventsDeleted: 3, aggregatesDeleted: 1 });
    // Aucun champ non déterministe (pas de durationMs) dans la réponse.
    expect(Object.keys(body).sort()).toEqual([
      'aggregatedEnvironments',
      'aggregationDaysProcessed',
      'collectionEnvironment',
      'ok',
      'productionCollectionEnabled',
      'purge',
      'window',
    ]);
  });

  it('n’expose aucune donnée sensible', async () => {
    const response = await GET(requestWith('Bearer secret-valide'));
    const serialized = JSON.stringify(await response.json());

    for (const forbidden of ['sourceId', 'customerId', 'organizationId', 'ip', 'sku', 'stripe']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
    expect(serialized).not.toContain('secret-valide');
  });
});

describe('18-A — cron process-product-analytics : invariant PRODUCTION', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = 'secret-valide';
    vi.mocked(maintenance.runProductAnalyticsMaintenance).mockResolvedValue(successResult());
  });

  it('affirme productionCollectionEnabled = false et n’agrège jamais PRODUCTION', async () => {
    const response = await GET(requestWith('Bearer secret-valide'));
    const body = await response.json();

    expect(body.productionCollectionEnabled).toBe(false);
    expect(body.aggregatedEnvironments).not.toContain('PRODUCTION');
    expect(body.collectionEnvironment).not.toBe('PRODUCTION');
  });

  it('ne peut pas activer la collecte PRODUCTION même si la variable l’exige', async () => {
    // Le verrou G7H-B rend PRODUCTION inatteignable : la route n’écrit aucune
    // configuration et le résolveur normalise PRODUCTION en DISABLED.
    process.env.PRODUCT_ANALYTICS_ENVIRONMENT = 'PRODUCTION';

    try {
      const response = await GET(requestWith('Bearer secret-valide'));
      const body = await response.json();

      expect(body.productionCollectionEnabled).toBe(false);
      expect(['DEVELOPMENT', 'TEST', 'DISABLED']).toContain(body.collectionEnvironment);
      expect(body.collectionEnvironment).not.toBe('PRODUCTION');
      expect(body.aggregatedEnvironments).not.toContain('PRODUCTION');
    } finally {
      delete process.env.PRODUCT_ANALYTICS_ENVIRONMENT;
    }
  });
});

describe('18-A — cron process-product-analytics : erreur de maintenance bornée', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = 'secret-valide';
  });

  it('renvoie 500 avec un code allow-listé, jamais le message interne', async () => {
    vi.mocked(maintenance.runProductAnalyticsMaintenance).mockRejectedValue(
      new ProductAnalyticsError('ANALYTICS_UNAVAILABLE', 'détail interne à ne pas fuir'),
    );

    const response = await GET(requestWith('Bearer secret-valide'));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ ok: false, error: 'Maintenance Error', code: 'ANALYTICS_UNAVAILABLE' });
    expect(JSON.stringify(body)).not.toContain('détail interne');
  });

  it('normalise un code hors allow-list en MAINTENANCE_FAILED', async () => {
    vi.mocked(maintenance.runProductAnalyticsMaintenance).mockRejectedValue(
      new ProductAnalyticsError('DUPLICATE_CONFLICT', 'conflit interne'),
    );

    const response = await GET(requestWith('Bearer secret-valide'));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.code).toBe('MAINTENANCE_FAILED');
    expect(JSON.stringify(body)).not.toContain('DUPLICATE_CONFLICT');
  });

  it('borne une erreur technique non typée en 500 générique', async () => {
    vi.mocked(maintenance.runProductAnalyticsMaintenance).mockRejectedValue(
      new Error('connection string postgresql://user:pass@host/db'),
    );

    const response = await GET(requestWith('Bearer secret-valide'));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: 'Internal Server Error' });
    expect(JSON.stringify(body)).not.toContain('postgresql');
  });
});

describe('18-A — cron process-product-analytics : câblage base de données', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = 'secret-valide';
    vi.mocked(maintenance.runProductAnalyticsMaintenance).mockResolvedValue(successResult());
  });

  it('passe le client de base de données résolu par getDb', async () => {
    await GET(requestWith('Bearer secret-valide'));

    expect(dbMod.getDb).toHaveBeenCalledTimes(1);
    expect(vi.mocked(maintenance.runProductAnalyticsMaintenance).mock.calls[0]?.[0]).toBe(
      vi.mocked(dbMod.getDb).mock.results[0]?.value,
    );
  });
});
