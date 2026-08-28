import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import { searchSupport } from './search';

describe('searchSupport (Unit)', () => {
  it('retourne un résultat vide si la chaîne de recherche est vide ou ne contient que des espaces', async () => {
    const fakeDb = {
      select: vi.fn(),
    } as unknown as DatabaseClient;

    const res1 = await searchSupport(fakeDb, '');
    expect(res1.totalMatches).toBe(0);
    expect(res1.items).toHaveLength(0);

    const res2 = await searchSupport(fakeDb, '   ');
    expect(res2.totalMatches).toBe(0);
    expect(res2.items).toHaveLength(0);
  });
});
