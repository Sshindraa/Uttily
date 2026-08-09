import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicSearchError } from '@uttily/core';

const executePublicSearchMock = vi.fn();

vi.mock('@/lib/db', () => ({ getDb: () => ({ kind: 'fake-db' }) }));
vi.mock('@/lib/public-search', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/public-search')>();
  return { ...original, executePublicSearch: executePublicSearchMock };
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
