import { NextResponse } from 'next/server';
import { PublicSearchError, safeRecordAnalyticsEvent } from '@uttily/core';
import { getDb } from '@/lib/db';
import { getAnalyticsEnvironment } from '@/lib/product-analytics';
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

  let result;
  try {
    result = await executePublicSearch(getDb(), parsed.input);
  } catch (error) {
    if (error instanceof PublicSearchError) {
      return jsonNoStore({ error: { code: error.code } }, publicSearchHttpStatus(error.code));
    }
    console.error(JSON.stringify({ event: 'public-search.error' }));
    return jsonNoStore({ error: { code: 'SEARCH_UNAVAILABLE' } }, 503);
  }

  // G7H-B — Émettre PUBLIC_SEARCH_PERFORMED après une recherche réussie.
  // Chaque exécution serveur réussie constitue une recherche distincte.
  // sourceId et occurredAt sont capturés une fois par exécution.
  // Aucun identifiant client, session, IP, user-agent ou paramètre de recherche
  // n'est collecté. L'écriture analytics est attendue avant la réponse mais
  // une erreur analytics ne doit JAMAIS transformer une recherche réussie en
  // erreur HTTP.
  const searchSourceId = crypto.randomUUID();
  const searchOccurredAt = new Date();
  try {
    await safeRecordAnalyticsEvent(
      getDb(),
      {
        eventType: 'PUBLIC_SEARCH_PERFORMED',
        sourceId: searchSourceId,
        occurredAt: searchOccurredAt,
        hasResults: result.items.length > 0,
      },
      getAnalyticsEnvironment(),
    );
  } catch {
    // Best-effort : une erreur analytics ne doit JAMAIS transformer une
    // recherche réussie en erreur HTTP. safeRecordAnalyticsEvent ne rethrow
    // normalement jamais, mais ce try/catch est une défense en profondeur.
  }

  return jsonNoStore(result, 200);
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
