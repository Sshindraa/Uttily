import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import {
  getOrganizationSupportDetails,
  SupportOrganizationNotFoundError,
} from './organization-support';

describe('getOrganizationSupportDetails (Unit)', () => {
  it('lève SupportOrganizationNotFoundError si l\u2019organisation n\u2019existe pas', async () => {
    const fakeDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    } as unknown as DatabaseClient;

    await expect(
      getOrganizationSupportDetails(fakeDb, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow(SupportOrganizationNotFoundError);
  });
});
