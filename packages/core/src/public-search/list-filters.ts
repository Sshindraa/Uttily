import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { categories, countries, destinations, destinationTranslations } from '@uttily/database';
import { PublicSearchError } from './errors';
import { isPaddleReadinessCategorySlug } from '../catalog/equipment-taxonomy';

export interface PublicSearchDestinationOption {
  publicId: string;
  slug: string;
  label: string;
  countryCode: string;
  placeType: string;
  center: {
    latitude: number;
    longitude: number;
  };
  bbox: {
    south: number;
    west: number;
    north: number;
    east: number;
  };
}

export interface PublicSearchCategoryOption {
  id: string;
  slug: string;
  name: string;
  /** Parent actif ou non ; la présentation ne suppose jamais sa présence dans la liste. */
  parentId?: string | null;
}

export interface PublicSearchFilterOptions {
  destinations: PublicSearchDestinationOption[];
  categories: PublicSearchCategoryOption[];
}

/**
 * Le slug historique `paddle` reste lisible en interne mais n'est pas une
 * catégorie commerciale publique tant que le contrat paddle n'est pas validé.
 */
export function filterPublicSearchCategories<T extends Pick<PublicSearchCategoryOption, 'slug'>>(
  rows: readonly T[],
): T[] {
  return rows.filter((row) => !isPaddleReadinessCategorySlug(row.slug));
}

/**
 * Charge les choix publiquement sélectionnables dans le formulaire G7E.
 *
 * Une destination n'est exposée que si elle, son pays et sa traduction dans
 * la locale demandée sont actifs/disponibles. Il n'existe aucun fallback vers
 * une autre langue : FR et EN sont des contenus explicitement activés.
 */
export async function listPublicSearchFilterOptions(
  db: DatabaseClient,
  locale: string,
): Promise<PublicSearchFilterOptions> {
  const resolvedLocale = resolvePublicUiLocale(locale);

  const [destinationRows, categoryRows] = await Promise.all([
    db
      .select({
        publicId: destinations.publicId,
        slug: destinations.slug,
        label: destinationTranslations.label,
        countryCode: destinations.countryCode,
        placeType: destinations.placeType,
        centerLatitude: sql<number>`ST_Y(${destinations.center})`,
        centerLongitude: sql<number>`ST_X(${destinations.center})`,
        bboxSouth: destinations.bboxSouth,
        bboxWest: destinations.bboxWest,
        bboxNorth: destinations.bboxNorth,
        bboxEast: destinations.bboxEast,
      })
      .from(destinations)
      .innerJoin(countries, eq(countries.countryCode, destinations.countryCode))
      .innerJoin(
        destinationTranslations,
        and(
          eq(destinationTranslations.destinationId, destinations.id),
          eq(destinationTranslations.locale, resolvedLocale),
        ),
      )
      .where(
        and(
          eq(destinations.isActive, true),
          isNull(destinations.deletedAt),
          eq(countries.isActive, true),
        ),
      )
      .orderBy(
        asc(destinations.sortOrder),
        asc(destinationTranslations.label),
        asc(destinations.id),
      ),
    db
      .select({
        id: categories.id,
        slug: categories.slug,
        name: categories.name,
        parentId: categories.parentId,
      })
      .from(categories)
      .where(eq(categories.isActive, true))
      .orderBy(asc(categories.name), asc(categories.id)),
  ]);

  return {
    destinations: destinationRows.map((destination) => ({
      publicId: destination.publicId,
      slug: destination.slug,
      label: destination.label,
      countryCode: destination.countryCode,
      placeType: destination.placeType,
      center: {
        latitude: Number(destination.centerLatitude),
        longitude: Number(destination.centerLongitude),
      },
      bbox: {
        south: Number(destination.bboxSouth),
        west: Number(destination.bboxWest),
        north: Number(destination.bboxNorth),
        east: Number(destination.bboxEast),
      },
    })),
    categories: filterPublicSearchCategories(categoryRows),
  };
}

function resolvePublicUiLocale(locale: string): 'fr' | 'en' {
  const base = locale.trim().toLowerCase().replace(/_/g, '-').split('-')[0];
  if (base === 'fr' || base === 'en') return base;
  throw new PublicSearchError('INVALID_INPUT', 'Locale publique non supportée.');
}
