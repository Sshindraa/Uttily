'use server';

import { listPublicSearchFilterOptions, type PublicSearchFilterOptions } from '@uttily/core';
import { getDb } from '@/lib/db';

export async function loadHomeSearchOptions(
  locale: 'fr' | 'en',
): Promise<PublicSearchFilterOptions | null> {
  if (locale !== 'fr' && locale !== 'en') return null;
  try {
    return await listPublicSearchFilterOptions(getDb(), locale);
  } catch {
    // Only public filter options are exposed; never return database/provider errors.
    return null;
  }
}
