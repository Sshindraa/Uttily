import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAuthenticatedUserMock, buildPersonalDataCopyMock, buildPortableDataMock } = vi.hoisted(
  () => ({
    getAuthenticatedUserMock: vi.fn(),
    buildPersonalDataCopyMock: vi.fn(),
    buildPortableDataMock: vi.fn(),
  }),
);

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: getAuthenticatedUserMock,
}));

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => ({})),
}));

vi.mock('@uttily/core', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@uttily/core');
  return {
    ...actual,
    buildPersonalDataCopy: buildPersonalDataCopyMock,
    buildPortableData: buildPortableDataMock,
  };
});

const { GET } = await import('./route');

describe('GET /api/account/privacy/export', () => {
  const user = { id: '00000000-0000-4000-8000-000000000001', email: 'test@example.com' };

  beforeEach(() => {
    getAuthenticatedUserMock.mockReset();
    buildPersonalDataCopyMock.mockReset();
    buildPortableDataMock.mockReset();
  });

  it('renvoie 401 si non authentifié', async () => {
    getAuthenticatedUserMock.mockResolvedValue(null);

    const response = await GET(new Request('http://localhost/api/account/privacy/export'));
    expect(response.status).toBe(401);
  });

  it('renvoie la structure complète Art. 15 et Art. 20 si authentifié', async () => {
    getAuthenticatedUserMock.mockResolvedValue(user);
    buildPersonalDataCopyMock.mockResolvedValue({
      profile: {
        id: user.id,
        displayName: 'Alice',
        locale: 'fr',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      bookings: [],
    });
    buildPortableDataMock.mockResolvedValue({
      profileProvided: { email: user.email, displayName: 'Alice', locale: 'fr' },
      bookingsInitiated: [],
    });

    const response = await GET(new Request('http://localhost/api/account/privacy/export'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('Content-Disposition')).toContain('uttily-personal-data-00000000-');
    expect(response.headers.get('Cache-Control')).toContain('private');

    const body = await response.json();
    expect(body.uttily_export_version).toBe('1.0');
    expect(body.article15_personal_data_copy).toBeDefined();
    expect(body.article20_portable_data).toBeDefined();
    expect(body.article15_personal_data_copy.profile.displayName).toBe('Alice');
  });

  it('supporte le scope portability seul via ?scope=portability', async () => {
    getAuthenticatedUserMock.mockResolvedValue(user);
    buildPortableDataMock.mockResolvedValue({
      profileProvided: { email: user.email, displayName: 'Alice', locale: 'fr' },
      bookingsInitiated: [],
    });

    const response = await GET(
      new Request('http://localhost/api/account/privacy/export?scope=portability'),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toContain('uttily-portable-data-00000000-');

    const body = await response.json();
    expect(body.uttily_export_version).toBe('1.0');
    expect(body.article20_portable_data).toBeDefined();
    expect(body.article15_personal_data_copy).toBeUndefined();
    expect(buildPersonalDataCopyMock).not.toHaveBeenCalled();
  });
});
