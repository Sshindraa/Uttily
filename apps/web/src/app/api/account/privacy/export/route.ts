import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { buildPersonalDataCopy, buildPortableData, type PersonalDataExport } from '@uttily/core';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Route d'export des données personnelles de l'utilisateur connecté.
 *
 * Scindée en deux namespaces distincts :
 * - `article15_personal_data_copy` : Copie intelligible des données détenues (Art. 15).
 * - `article20_portable_data` : Dataset structuré et lisible par machine (Art. 20).
 *
 * Supporte le paramètre `?scope=portability` pour n'exporter que le bloc Art. 20.
 */
export async function GET(request: Request): Promise<Response> {
  const user = await getAuthenticatedUser();
  if (!user) {
    return new Response(JSON.stringify({ error: 'Non authentifié' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const db = getDb();
  const url = new URL(request.url);
  const scope = url.searchParams.get('scope');

  const nowIso = new Date().toISOString();
  const userIdShort = user.id.slice(0, 8);
  const dateShort = nowIso.slice(0, 10);

  if (scope === 'portability') {
    const portableData = await buildPortableData(db, user.id);
    const body = {
      exportedAt: nowIso,
      uttily_export_version: '1.0' as const,
      article20_portable_data: portableData,
    };
    return new Response(JSON.stringify(body, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="uttily-portable-data-${userIdShort}-${dateShort}.json"`,
        'Cache-Control': 'private, no-cache, no-store, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  const [personalDataCopy, portableData] = await Promise.all([
    buildPersonalDataCopy(db, user.id),
    buildPortableData(db, user.id),
  ]);

  const exportPayload: PersonalDataExport = {
    exportedAt: nowIso,
    uttily_export_version: '1.0',
    article15_personal_data_copy: personalDataCopy,
    article20_portable_data: portableData,
  };

  return new Response(JSON.stringify(exportPayload, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="uttily-personal-data-${userIdShort}-${dateShort}.json"`,
      'Cache-Control': 'private, no-cache, no-store, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
