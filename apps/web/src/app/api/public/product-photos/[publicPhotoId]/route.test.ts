import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, getProductPhotoStorageMock, storageGetMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getProductPhotoStorageMock: vi.fn(),
  storageGetMock: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ getDb: getDbMock }));
vi.mock('@/lib/product-photo-storage', () => ({
  getProductPhotoStorage: getProductPhotoStorageMock,
}));

const { GET } = await import('./route');

const validPublicPhotoId = '00000000-0000-4000-8000-000000000001';

function mockDatabase(photo: Record<string, unknown> | null): void {
  const limit = vi.fn().mockResolvedValue(photo ? [photo] : []);
  const where = vi.fn(() => ({ limit }));
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ innerJoin }));
  getDbMock.mockReturnValue({ select: vi.fn(() => ({ from })) });
}

beforeEach(() => {
  getDbMock.mockReset();
  getProductPhotoStorageMock.mockReset();
  storageGetMock.mockReset();
  getProductPhotoStorageMock.mockReturnValue({
    get: storageGetMock,
  });
});

describe('GET /api/public/product-photos/[publicPhotoId]', () => {
  it('répond 404 sans toucher à la base pour un identifiant malformé', async () => {
    const response = await GET(new Request('http://localhost/api/public/product-photos/nope'), {
      params: Promise.resolve({ publicPhotoId: 'nope' }),
    });

    expect(response.status).toBe(404);
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it('sert uniquement une photo publiée via le stockage privé', async () => {
    mockDatabase({
      storageKey: 'product-photos/org/product/photo',
      contentType: 'image/png',
      widthPx: 800,
      heightPx: 600,
    });
    storageGetMock.mockResolvedValue(new Uint8Array([137, 80, 78, 71]));

    const response = await GET(
      new Request(`https://staging.example/api/public/product-photos/${validPublicPhotoId}`),
      { params: Promise.resolve({ publicPhotoId: validPublicPhotoId }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Cache-Control')).toBe(
      'public, max-age=300, stale-while-revalidate=86400',
    );
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(storageGetMock).toHaveBeenCalledWith('product-photos/org/product/photo');
    await expect(response.arrayBuffer()).resolves.toEqual(new Uint8Array([137, 80, 78, 71]).buffer);
  });

  it('refuse un type stocké qui ne fait pas partie des formats photo', async () => {
    mockDatabase({
      storageKey: 'product-photos/org/product/photo',
      contentType: 'application/pdf',
      widthPx: null,
      heightPx: null,
    });

    const response = await GET(new Request('http://localhost/api/public/product-photos/x'), {
      params: Promise.resolve({ publicPhotoId: validPublicPhotoId }),
    });

    expect(response.status).toBe(404);
    expect(storageGetMock).not.toHaveBeenCalled();
  });
});
