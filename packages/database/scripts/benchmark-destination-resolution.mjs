import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, '..', '..');
const CORPUS_PATH = resolve(REPOSITORY_ROOT, 'docs/implementation/g8b-2b-lyon-corpus.json');
const LOCAL_DATABASE_URL = 'postgresql://uttily:uttily@127.0.0.1:5432/uttily';
const REQUEST_TIMEOUT_MS = 10_000;
const NETWORK_PAUSE_MS = 150;

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('fr')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function distanceKm(left, right) {
  const earthRadiusKm = 6371;
  const lat1 = (left.latitude * Math.PI) / 180;
  const lat2 = (right.latitude * Math.PI) / 180;
  const deltaLat = ((right.latitude - left.latitude) * Math.PI) / 180;
  const deltaLon = ((right.longitude - left.longitude) * Math.PI) / 180;
  const haversine =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function scoreLocalDestination(destination, query) {
  const normalizedQuery = normalizeText(query);
  if (normalizedQuery.length === 0) return 4;

  const label = normalizeText(destination.labels);
  const slug = normalizeText(destination.slug);
  const searchable = `${label} ${slug} ${destination.countryCode.toLocaleLowerCase('fr')}`;

  if (label === normalizedQuery) return 0;
  if (label.startsWith(normalizedQuery)) return 1;
  if (label.split(' ').some((word) => word.startsWith(normalizedQuery))) return 2;
  if (searchable.includes(normalizedQuery)) return 3;
  return null;
}

function evaluateResult(result, expectation, anchor) {
  if (!result) return false;

  const resultPoint = { latitude: result.latitude, longitude: result.longitude };
  if (expectation.kind === 'outside-lyon') {
    return distanceKm(resultPoint, anchor) >= expectation.minimumDistanceKm;
  }

  return distanceKm(resultPoint, expectation) <= expectation.radiusKm;
}

function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function formatMs(value) {
  return value === null ? 'n/a' : `${value.toFixed(1)} ms`;
}

function parseArgs(argv) {
  return {
    network: argv.includes('--network'),
    json: argv.includes('--json'),
  };
}

async function loadCorpus() {
  return JSON.parse(await readFile(CORPUS_PATH, 'utf8'));
}

async function queryLocal(sql, testCase) {
  const startedAt = performance.now();
  const rows = await sql`
    SELECT
      d."slug",
      d."country_code" AS "countryCode",
      d."place_type" AS "placeType",
      ST_Y(d."center")::double precision AS "latitude",
      ST_X(d."center")::double precision AS "longitude",
      COALESCE(string_agg(dt."label", ' ' ORDER BY dt."locale"), '') AS "labels"
    FROM "destinations" d
    JOIN "countries" c ON c."country_code" = d."country_code"
    JOIN "destination_translations" dt ON dt."destination_id" = d."id"
    WHERE d."is_active" = true
      AND d."deleted_at" IS NULL
      AND c."is_active" = true
    GROUP BY d."id"
    ORDER BY d."sort_order" ASC, d."slug" ASC
  `;

  const suggestions = rows
    .flatMap((destination, index) => {
      const score = scoreLocalDestination(destination, testCase.query);
      return score === null ? [] : [{ destination, index, score }];
    })
    .sort((left, right) =>
      left.score === right.score ? left.index - right.index : left.score - right.score,
    )
    .slice(0, 3)
    .map(({ destination }) => ({
      label: destination.labels.split(' ')[0] || destination.slug,
      latitude: Number(destination.latitude),
      longitude: Number(destination.longitude),
      type: destination.placeType,
    }));

  return {
    provider: 'postgres-local',
    status: 'ok',
    latencyMs: performance.now() - startedAt,
    results: suggestions,
  };
}

function providerUrl(provider, query) {
  if (provider === 'photon') {
    const url = new URL('https://photon.komoot.io/api/');
    url.searchParams.set('q', query);
    url.searchParams.set('limit', '3');
    url.searchParams.set('lang', 'fr');
    return url;
  }

  const url = new URL('https://data.geopf.fr/geocodage/search');
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '3');
  return url;
}

function parseExternalResults(provider, payload) {
  const features = provider === 'photon' ? (payload.features ?? []) : (payload.features ?? []);
  return features.slice(0, 3).flatMap((feature) => {
    const coordinates = feature.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return [];

    const properties = feature.properties ?? {};
    const label =
      provider === 'photon'
        ? [properties.name, properties.street, properties.city, properties.country]
            .filter(Boolean)
            .join(', ')
        : (properties.label ??
          [properties.name, properties.street, properties.city, properties.municipality]
            .filter(Boolean)
            .join(', '));

    return [
      {
        label: label || 'unnamed',
        latitude: Number(coordinates[1]),
        longitude: Number(coordinates[0]),
        type: properties.type ?? properties._type ?? null,
      },
    ];
  });
}

async function queryExternal(provider, testCase) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(providerUrl(provider, testCase.query), {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Uttily-G8B-2B-development-benchmark/1.0',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return {
      provider,
      status: 'ok',
      latencyMs: performance.now() - startedAt,
      results: parseExternalResults(provider, payload),
    };
  } catch (error) {
    return {
      provider,
      status: 'error',
      latencyMs: performance.now() - startedAt,
      results: [],
      error: error instanceof Error ? error.message : 'unknown error',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function summarize(provider, corpus, results) {
  const successful = results.filter((result) => result.status === 'ok');
  const latencies = successful.map((result) => result.latencyMs);
  const top1Hits = successful.filter((result) =>
    evaluateResult(result.results[0], result.testCase.expectation, corpus.anchor),
  ).length;
  const top3Hits = successful.filter((result) =>
    result.results.some((candidate) =>
      evaluateResult(candidate, result.testCase.expectation, corpus.anchor),
    ),
  ).length;

  return {
    provider,
    cases: corpus.cases.length,
    successful: successful.length,
    errors: results.length - successful.length,
    top1Hits,
    top3Hits,
    top1Rate: successful.length === 0 ? null : top1Hits / successful.length,
    top3Rate: successful.length === 0 ? null : top3Hits / successful.length,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
  };
}

function printSummary(summary) {
  const accuracy = `${summary.top1Hits}/${summary.cases} top-1, ${summary.top3Hits}/${summary.cases} top-3`;
  console.log(
    `${summary.provider}: ${accuracy}; ${summary.errors} erreur(s); ` +
      `p50=${formatMs(summary.p50Ms)}, p95=${formatMs(summary.p95Ms)}`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const corpus = await loadCorpus();
  const sql = postgres(process.env.DATABASE_URL ?? LOCAL_DATABASE_URL, { max: 1 });
  const resultsByProvider = { 'postgres-local': [], photon: [], ign: [] };

  try {
    for (const testCase of corpus.cases) {
      resultsByProvider['postgres-local'].push({
        testCase,
        ...(await queryLocal(sql, testCase)),
      });
    }

    if (options.network) {
      for (const provider of ['photon', 'ign']) {
        for (const testCase of corpus.cases) {
          resultsByProvider[provider].push({
            testCase,
            ...(await queryExternal(provider, testCase)),
          });
          await new Promise((resolvePromise) => setTimeout(resolvePromise, NETWORK_PAUSE_MS));
        }
      }
    }
  } finally {
    await sql.end();
  }

  const summaries = [
    summarize('postgres-local', corpus, resultsByProvider['postgres-local']),
    ...(options.network
      ? [
          summarize('photon', corpus, resultsByProvider.photon),
          summarize('ign', corpus, resultsByProvider.ign),
        ]
      : []),
  ];

  if (options.json) {
    console.log(
      JSON.stringify({ corpus: CORPUS_PATH, summaries, results: resultsByProvider }, null, 2),
    );
    return;
  }

  console.log(`G8B-2B — ${corpus.name}`);
  console.log(
    `Corpus: ${corpus.cases.length} cas; mode réseau: ${options.network ? 'activé' : 'désactivé'}`,
  );
  summaries.forEach(printSummary);
  if (!options.network) {
    console.log(
      'Photon/IGN non exécutés. Relancer avec --network pour les interroger explicitement.',
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
