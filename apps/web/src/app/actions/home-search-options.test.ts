import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadHomeSearchOptions } from './home-search-options';

const mocks = vi.hoisted(() => ({ list: vi.fn(), db: vi.fn(() => ({ public: true })) }));
vi.mock('@uttily/core', () => ({ listPublicSearchFilterOptions: mocks.list }));
vi.mock('@/lib/db', () => ({ getDb: mocks.db }));

describe('Homepage public search options', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(['fr', 'en'] as const)('loads only existing public filters in %s', async (locale) => {
    const options = { destinations: [], categories: [] };
    mocks.list.mockResolvedValueOnce(options);
    expect(await loadHomeSearchOptions(locale)).toEqual(options);
    expect(mocks.list).toHaveBeenCalledWith({ public: true }, locale);
  });
  it('rejects unsupported runtime locales before accessing the database', async () => {
    expect(await loadHomeSearchOptions('de' as 'fr')).toBeNull();
    expect(mocks.db).not.toHaveBeenCalled();
  });
  it('does not expose database errors', async () => {
    mocks.list.mockRejectedValueOnce(new Error('private database detail'));
    expect(await loadHomeSearchOptions('fr')).toBeNull();
  });
});
