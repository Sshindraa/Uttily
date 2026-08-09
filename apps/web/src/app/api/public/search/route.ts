import { NextResponse } from 'next/server';
import { PublicSearchError } from '@uttily/core';
import { getDb } from '@/lib/db';
import {
  executePublicSearch,
  parsePublicSearchParams,
  publicSearchHttpStatus,
  type PublicUiLocale,
} from '@/lib/public-search';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const locale = resolveLocale(params.get('locale'));
  if (!locale) {
    return jsonNoStore({ error: { code: 'INVALID_INPUT' } }, 400);
  }

  const parsed = parsePublicSearchParams(params, locale);
  if (parsed.kind !== 'VALID') {
    return jsonNoStore({ error: { code: 'INVALID_INPUT' } }, 400);
  }

  try {
    const result = await executePublicSearch(getDb(), parsed.input);
    return jsonNoStore(result, 200);
  } catch (error) {
    if (error instanceof PublicSearchError) {
      return jsonNoStore({ error: { code: error.code } }, publicSearchHttpStatus(error.code));
    }
    console.error(JSON.stringify({ event: 'public-search.error' }));
    return jsonNoStore({ error: { code: 'SEARCH_UNAVAILABLE' } }, 503);
  }
}

function jsonNoStore(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

function resolveLocale(value: string | null): PublicUiLocale | null {
  if (value === 'fr' || value === 'en') return value;
  return null;
}
