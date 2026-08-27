import type { PublicSearchDestinationOption } from '@uttily/core';

const MAX_SUGGESTIONS = 8;

export function normalizeDestinationQuery(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('fr')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function destinationDisplayLabel(destination: PublicSearchDestinationOption): string {
  return `${destination.label} · ${destination.countryCode}`;
}

export function rankDestinationSuggestions(
  destinations: PublicSearchDestinationOption[],
  query: string,
  limit = MAX_SUGGESTIONS,
): PublicSearchDestinationOption[] {
  const normalizedQuery = normalizeDestinationQuery(query);

  return destinations
    .flatMap((destination, index) => {
      const score = scoreDestination(destination, normalizedQuery);
      return score === null ? [] : [{ destination, index, score }];
    })
    .sort((left, right) =>
      left.score === right.score ? left.index - right.index : left.score - right.score,
    )
    .slice(0, Math.max(0, limit))
    .map((candidate) => candidate.destination);
}

function scoreDestination(
  destination: PublicSearchDestinationOption,
  normalizedQuery: string,
): number | null {
  if (normalizedQuery.length === 0) return 4;

  const label = normalizeDestinationQuery(destination.label);
  const slug = normalizeDestinationQuery(destination.slug);
  const searchable = `${label} ${slug} ${destination.countryCode.toLocaleLowerCase('fr')}`;

  if (label === normalizedQuery) return 0;
  if (label.startsWith(normalizedQuery)) return 1;
  if (label.split(' ').some((word) => word.startsWith(normalizedQuery))) return 2;
  if (searchable.includes(normalizedQuery)) return 3;
  return null;
}
