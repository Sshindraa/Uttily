import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicSearchError } from '@uttily/core';

const { executePublicSearchMock, safeRecordAnalyticsEventMock, getAnalyticsEnvironmentMock } =
  vi.hoisted(() => ({
    executePublicSearchMock: vi.fn(),
    safeRecordAnalyticsEventMock: vi.fn(),
    getAnalyticsEnvironmentMock: vi.fn(),
  }));

vi.mock('@/lib/db', () => ({ getDb: () => ({ kind: 'fake-db' }) }));
vi.mock('@/lib/public-search', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/public-search')>();
  return { ...original, executePublicSearch: executePublicSearchMock };
});
vi.mock('@/lib/product-analytics', () => ({
  getAnalyticsEnvironment: getAnalyticsEnvironmentMock,
}));
vi.mock('@uttily/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@uttily/core')>();
  return { ...original, safeRecordAnalyticsEvent: safeRecordAnalyticsEventMock };
});

const { GET } = await import('./route');

const validQuery = new URLSearchParams({
  locale: 'fr',
  destinationPublicId: '00000000-0000-0000-0000-000000000001',
  intent: 'DAY_RANGE',
  startDate: '2026-08-10',
  endDateExclusive: '2026-08-13',
});

beforeEach(() => {
  executePublicSearchMock.mockReset();
  safeRecordAnalyticsEventMock.mockReset();
  getAnalyticsEnvironmentMock.mockReset();
  getAnalyticsEnvironmentMock.mockReturnValue('DEVELOPMENT');
  safeRecordAnalyticsEventMock.mockResolvedValue('RECORDED');
});

describe('GET /api/public/search', () => {
  it('refuse une locale non supportée sans lancer le moteur', async () => {
    const response = await GET(new Request('http://localhost/api/public/search?locale=de'));
    expect(response.status).toBe(400);
    expect(executePublicSearchMock).not.toHaveBeenCalled();
  });

  it('refuse des critères incomplets sans lancer le moteur', async () => {
    const response = await GET(new Request('http://localhost/api/public/search?locale=fr'));
    expect(response.status).toBe(400);
    expect(executePublicSearchMock).not.toHaveBeenCalled();
  });

  it('refuse un viewport partiel ou non fini sans lancer le moteur', async () => {
    const params = new URLSearchParams(validQuery);
    params.set('viewportSouth', '45.8');
    params.set('viewportWest', '6');
    params.set('viewportNorth', 'Infinity');
    const response = await GET(
      new Request(`http://localhost/api/public/search?${params.toString()}`),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(executePublicSearchMock).not.toHaveBeenCalled();
  });

  it('transmet le viewport explicite pour lier la pagination au même viewport', async () => {
    executePublicSearchMock.mockResolvedValue({ items: [], nextCursor: null });
    const params = new URLSearchParams(validQuery);
    params.set('cursor', 'old-cursor');
    params.set('viewportSouth', '45.8');
    params.set('viewportWest', '6');
    params.set('viewportNorth', '46');
    params.set('viewportEast', '6.3');
    const response = await GET(
      new Request(`http://localhost/api/public/search?${params.toString()}`),
    );
    expect(response.status).toBe(200);
    expect(executePublicSearchMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cursor: 'old-cursor',
        viewport: { kind: 'VIEWPORT', south: 45.8, west: 6, north: 46, east: 6.3 },
      }),
    );
  });

  it('retourne le read model public avec no-store', async () => {
    executePublicSearchMock.mockResolvedValue({ items: [], nextCursor: null });
    const response = await GET(
      new Request(`http://localhost/api/public/search?${validQuery.toString()}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('mappe une panne du gate en 503 avec un code fermé', async () => {
    executePublicSearchMock.mockRejectedValue(
      new PublicSearchError('PUBLICATION_GATE_UNAVAILABLE', 'détail interne'),
    );
    const response = await GET(
      new Request(`http://localhost/api/public/search?${validQuery.toString()}`),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      error: { code: 'PUBLICATION_GATE_UNAVAILABLE' },
    });
  });
});

describe('GET /api/public/search — analytics (G7H-B)', () => {
  it('emet PUBLIC_SEARCH_PERFORMED avec hasResults=true apres une recherche avec resultats', async () => {
    executePublicSearchMock.mockResolvedValue({
      items: [{ id: 'item-1' }, { id: 'item-2' }],
      nextCursor: null,
    });
    const response = await GET(
      new Request(`http://localhost/api/public/search?${validQuery.toString()}`),
    );
    expect(response.status).toBe(200);
    expect(safeRecordAnalyticsEventMock).toHaveBeenCalledTimes(1);
    const callArgs = safeRecordAnalyticsEventMock.mock.calls[0]!;
    expect(callArgs[1]).toMatchObject({
      eventType: 'PUBLIC_SEARCH_PERFORMED',
      hasResults: true,
    });
    // sourceId doit etre un UUID valide.
    expect(callArgs[1].sourceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // occurredAt doit etre une Date valide.
    expect(callArgs[1].occurredAt).toBeInstanceOf(Date);
    expect(Number.isFinite(callArgs[1].occurredAt.getTime())).toBe(true);
  });

  it('emet PUBLIC_SEARCH_PERFORMED avec hasResults=false apres une recherche sans resultats', async () => {
    executePublicSearchMock.mockResolvedValue({ items: [], nextCursor: null });
    const response = await GET(
      new Request(`http://localhost/api/public/search?${validQuery.toString()}`),
    );
    expect(response.status).toBe(200);
    expect(safeRecordAnalyticsEventMock).toHaveBeenCalledTimes(1);
    expect(safeRecordAnalyticsEventMock.mock.calls[0]![1]).toMatchObject({
      eventType: 'PUBLIC_SEARCH_PERFORMED',
      hasResults: false,
    });
  });

  it("n'emet pas d'evenement analytics sur une recherche echouee", async () => {
    executePublicSearchMock.mockRejectedValue(
      new PublicSearchError('PUBLICATION_GATE_UNAVAILABLE', 'detail interne'),
    );
    await GET(new Request(`http://localhost/api/public/search?${validQuery.toString()}`));
    expect(safeRecordAnalyticsEventMock).not.toHaveBeenCalled();
  });

  it("n'emet pas d'evenement analytics sur des criteres invalides", async () => {
    await GET(new Request('http://localhost/api/public/search?locale=fr'));
    expect(safeRecordAnalyticsEventMock).not.toHaveBeenCalled();
  });

  it("n'emet pas d'evenement analytics sur une locale invalide", async () => {
    await GET(new Request('http://localhost/api/public/search?locale=de'));
    expect(safeRecordAnalyticsEventMock).not.toHaveBeenCalled();
  });

  it('une erreur analytics ne transforme pas une recherche reussie en erreur HTTP', async () => {
    executePublicSearchMock.mockResolvedValue({ items: [], nextCursor: null });
    safeRecordAnalyticsEventMock.mockResolvedValue('FAILED');
    const response = await GET(
      new Request(`http://localhost/api/public/search?${validQuery.toString()}`),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('une erreur analytics lancee (pas FAILED) ne transforme pas une recherche reussie en erreur HTTP', async () => {
    executePublicSearchMock.mockResolvedValue({ items: [], nextCursor: null });
    safeRecordAnalyticsEventMock.mockRejectedValue(new Error('analytics DB down'));
    const response = await GET(
      new Request(`http://localhost/api/public/search?${validQuery.toString()}`),
    );
    // La route doit toujours retourner 200 meme si l'analytics echoue.
    // safeRecordAnalyticsEvent est cense ne jamais rethrow, mais on verifie
    // que la route est robuste meme si elle le faisait.
    expect(response.status).toBe(200);
  });

  it("n'emet pas d'evenement quand l'environnement est DISABLED", async () => {
    getAnalyticsEnvironmentMock.mockReturnValue('DISABLED');
    executePublicSearchMock.mockResolvedValue({ items: [], nextCursor: null });
    await GET(new Request(`http://localhost/api/public/search?${validQuery.toString()}`));
    // safeRecordAnalyticsEvent est appele mais retourne DISABLED sans appel DB.
    expect(safeRecordAnalyticsEventMock).toHaveBeenCalledTimes(1);
    expect(safeRecordAnalyticsEventMock.mock.calls[0]![2]).toBe('DISABLED');
  });

  it('chaque recherche reussie genere un sourceId distinct', async () => {
    executePublicSearchMock.mockResolvedValue({ items: [], nextCursor: null });
    await GET(new Request(`http://localhost/api/public/search?${validQuery.toString()}`));
    await GET(new Request(`http://localhost/api/public/search?${validQuery.toString()}`));
    expect(safeRecordAnalyticsEventMock).toHaveBeenCalledTimes(2);
    const sourceId1 = safeRecordAnalyticsEventMock.mock.calls[0]![1].sourceId;
    const sourceId2 = safeRecordAnalyticsEventMock.mock.calls[1]![1].sourceId;
    expect(sourceId1).not.toBe(sourceId2);
  });
});
