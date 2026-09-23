import type { PublicSearchCategoryOption } from '@uttily/core';
import { BIKE_SUBTYPE_DEFINITIONS, getBikeSubtypeLabel, type BikeSubtype } from '@uttily/contracts';
import { normalizeDestinationQuery } from '@/lib/destination-suggestions';
import { getPublicCategoryLabel } from '@/lib/public-search-labels';
import type { SearchLocale } from './search-state';

export type EquipmentTerrain = 'all' | 'land' | 'water' | 'snow';

export const BIKE_SUBTYPE_SUGGESTION_PREFIX = 'bike-subtype:';

export interface BikeSubtypeSuggestion {
  id: string;
  subtype: BikeSubtype;
}

export function getEquipmentTerrain(
  category: PublicSearchCategoryOption,
): Exclude<EquipmentTerrain, 'all'> | null {
  const slug = normalize(category.slug);
  if (/bike|velo|vtt|vtc|gravel|cycle/.test(slug)) return 'land';
  if (/kayak|canoe|paddle|pedalboat|surf|bodyboard|wingfoil|windsurf/.test(slug)) return 'water';
  if (/ski|snowboard|snow|raquette|luge|sled/.test(slug)) return 'snow';
  return null;
}

export function filterEquipmentFamilies(
  categories: PublicSearchCategoryOption[],
  terrain: EquipmentTerrain,
): PublicSearchCategoryOption[] {
  if (terrain === 'all') return categories;
  return categories.filter((category) => getEquipmentTerrain(category) === terrain);
}

// Exact meaning groups, not compatibility rules. No group broadens electric to all bikes.
const MEANINGS = [
  ['velo', 'velos', 'bike', 'bikes', 'bicycle', 'bicycles'],
  ['vtt', 'mtb', 'mountain bike', 'mountain bikes'],
  ['vtt electrique', 'electric mountain bike', 'e mtb', 'e vtt'],
  [
    'velo electrique',
    'velos electriques',
    'electric bike',
    'electric bikes',
    'vae',
    'e bike',
    'e bikes',
    'ebike',
    'ebikes',
  ],
  ['paddle', 'paddleboard', 'paddleboarding', 'stand up paddle', 'sup'],
  ['bodyboard', 'bodyboards', 'body board', 'bodyboarding', 'boogie board', 'boogieboard'],
  ['wingfoil', 'wing foil', 'wingfoiling', 'wing foiling'],
  ['kayak', 'kayaks'],
  ['ski', 'skis', 'ski alpin', 'ski de randonnée', 'ski de fond', 'alpine ski', 'touring ski'],
  ['vtc', 'hybrid bike', 'hybrid bikes'],
  ['velo de route', 'velo route', 'road bike', 'road bikes', 'route'],
] as const;

function normalize(value: string): string {
  return normalizeDestinationQuery(value).replace(/\belec\b/g, 'electrique');
}

function meaning(category: PublicSearchCategoryOption): readonly string[] | undefined {
  const names = [category.slug, category.name, getPublicCategoryLabel('en', category)].map(
    normalize,
  );
  return MEANINGS.find((group) =>
    names.some((name) => (group as readonly string[]).includes(name)),
  );
}

export function rankEquipmentSuggestions(
  categories: PublicSearchCategoryOption[],
  query: string,
  locale: SearchLocale,
): PublicSearchCategoryOption[] {
  const normalized = normalize(query);
  if (!normalized) return [];
  const tokens = normalized.split(' ');
  return categories
    .flatMap((category) => {
      // `foil` seul est une technologie ambiguë : il ne doit pas choisir
      // automatiquement la famille plus précise `wingfoil`.
      if (normalized === 'foil' && category.slug === 'wingfoil') return [];
      const terms = [
        category.slug,
        getPublicCategoryLabel(locale, category),
        ...(meaning(category) ?? []),
      ].map(normalize);
      const scores = terms.flatMap((term) =>
        term === normalized
          ? [0]
          : term.startsWith(normalized)
            ? [1]
            : tokens.every((token) =>
                  term
                    .split(' ')
                    .some((word) => word === token || (token.length > 1 && word.startsWith(token))),
                )
              ? [2]
              : [],
      );
      return scores.length ? [{ category, score: Math.min(...scores) }] : [];
    })
    .sort(
      (a, b) =>
        a.score - b.score ||
        getPublicCategoryLabel(locale, a.category).localeCompare(
          getPublicCategoryLabel(locale, b.category),
          locale,
        ),
    )
    .slice(0, 8)
    .map((item) => item.category);
}

/** Suggestions virtuelles pour les sous-types de la famille `bike`. */
export function rankBikeSubtypeSuggestions(
  query: string,
  locale: SearchLocale,
): BikeSubtypeSuggestion[] {
  const normalized = normalize(query);
  if (!normalized) return [];
  const tokens = normalized.split(' ');

  return BIKE_SUBTYPE_DEFINITIONS.flatMap((definition, order) => {
    const terms = [
      definition.slug,
      getBikeSubtypeLabel(locale, definition.slug),
      ...definition.aliases,
    ].map(normalize);
    const scores = terms.flatMap((term) =>
      term === normalized
        ? [0]
        : term.startsWith(normalized)
          ? [1]
          : tokens.every((token) =>
                term
                  .split(' ')
                  .some((word) => word === token || (token.length > 1 && word.startsWith(token))),
              )
            ? [2]
            : [],
    );
    return scores.length
      ? [
          {
            id: `${BIKE_SUBTYPE_SUGGESTION_PREFIX}${definition.slug}`,
            subtype: definition.slug,
            score: Math.min(...scores),
            order,
          },
        ]
      : [];
  })
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .slice(0, BIKE_SUBTYPE_DEFINITIONS.length)
    .map(({ id, subtype }) => ({ id, subtype }));
}

export function categoryBreadcrumb(
  category: PublicSearchCategoryOption,
  categories: PublicSearchCategoryOption[],
  locale: SearchLocale,
): string {
  const visited = new Set([category.id]);
  const labels = [getPublicCategoryLabel(locale, category)];
  let parentId = category.parentId;
  while (parentId && !visited.has(parentId) && labels.length < 4) {
    visited.add(parentId);
    const parent = categories.find((item) => item.id === parentId);
    if (!parent) break;
    labels.unshift(getPublicCategoryLabel(locale, parent));
    parentId = parent.parentId;
  }
  return labels.join(' › ');
}

export function equipmentFamilies(
  categories: PublicSearchCategoryOption[],
): PublicSearchCategoryOption[] {
  const ids = new Set(categories.map((category) => category.id));
  const roots = categories.filter((category) => !category.parentId || !ids.has(category.parentId));
  return roots
    .flatMap((category) => {
      const children = categories.filter((child) => child.parentId === category.id);
      return category.slug === 'equipment' && children.length ? children : [category];
    })
    .filter((category) => category.slug !== 'equipment');
}
