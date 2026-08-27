/**
 * @uttily/core — Module Public Search (G7E-B).
 *
 * Helpers géographiques pour la recherche publique.
 * Aucun appel à un géocodeur externe. Sans viewport choisi, les paliers
 * PostGIS 10/25/50 km sont appliqués autour du centre canonique.
 *
 * La zone exacte est définie par la bounding box canonique de la destination.
 * Sans viewport, les locations hors bbox mais à moins de 50 km sont candidates.
 * Avec un viewport explicite, la bbox du viewport reste la zone de recherche.
 * La distance est calculée en mètres via ST_Distance sur le cast geography
 * (SRID 4326).
 */

import type { PublicSearchGeographicMatch, PublicSearchViewport } from './types';

export const PUBLIC_SEARCH_RADIUS_TIERS = [
  { match: 'RADIUS_10KM', meters: 10_000 },
  { match: 'RADIUS_25KM', meters: 25_000 },
  { match: 'RADIUS_50KM', meters: 50_000 },
] as const satisfies ReadonlyArray<{
  match: Exclude<PublicSearchGeographicMatch, 'EXACT' | 'VIEWPORT_ALTERNATIVE'>;
  meters: number;
}>;

const PUBLIC_SEARCH_VIEWPORT_KEYS = ['east', 'kind', 'north', 'south', 'west'] as const;

/**
 * Validation runtime partagée du contrat géographique public.
 *
 * Cette fonction ne normalise pas et ne modifie jamais l'objet fourni. Elle
 * accepte west > east pour l'antiméridien et west === east pour une bande de
 * largeur nulle, mais refuse les nombres non finis et les propriétés inconnues.
 */
export function isValidPublicSearchViewport(value: unknown): value is PublicSearchViewport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const viewport = value as Record<string, unknown>;
  const actualKeys = Object.keys(viewport).sort();
  const expectedKeys = [...PUBLIC_SEARCH_VIEWPORT_KEYS].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    !expectedKeys.every((key, index) => actualKeys[index] === key)
  ) {
    return false;
  }
  if (viewport.kind !== 'VIEWPORT') return false;

  const south = viewport.south;
  const west = viewport.west;
  const north = viewport.north;
  const east = viewport.east;
  if (
    typeof south !== 'number' ||
    typeof west !== 'number' ||
    typeof north !== 'number' ||
    typeof east !== 'number' ||
    !Number.isFinite(south) ||
    !Number.isFinite(west) ||
    !Number.isFinite(north) ||
    !Number.isFinite(east)
  ) {
    return false;
  }
  return (
    south >= -90 &&
    south <= 90 &&
    north >= -90 &&
    north <= 90 &&
    west >= -180 &&
    west <= 180 &&
    east >= -180 &&
    east <= 180 &&
    south < north
  );
}

/**
 * Normalise les seules représentations numériques qui peuvent produire des
 * curseurs différents pour la même zone (`-0` et `0`).
 */
export function normalizePublicSearchViewport(
  viewport: PublicSearchViewport,
): PublicSearchViewport {
  const normalizeZero = (value: number): number => (Object.is(value, -0) ? 0 : value);
  return {
    kind: 'VIEWPORT',
    south: normalizeZero(viewport.south),
    west: normalizeZero(viewport.west),
    north: normalizeZero(viewport.north),
    east: normalizeZero(viewport.east),
  };
}

/**
 * Centre déterministe d'une bbox. Pour l'antiméridien, le milieu est calculé
 * sur l'arc court west → east modulo 360 puis ramené dans [-180, 180].
 */
export function publicSearchViewportCenter(viewport: PublicSearchViewport): {
  latitude: number;
  longitude: number;
} {
  const normalized = normalizePublicSearchViewport(viewport);
  const longitude =
    normalized.west <= normalized.east
      ? (normalized.west + normalized.east) / 2
      : normalized.west + (normalized.east + 360 - normalized.west) / 2;
  const wrappedLongitude = longitude > 180 ? longitude - 360 : longitude;
  return {
    latitude: (normalized.south + normalized.north) / 2,
    longitude: Object.is(wrappedLongitude, -0) ? 0 : wrappedLongitude,
  };
}

/**
 * Vérifie qu'un point (latitude, longitude) tombe dans la bounding box
 * de la destination.
 *
 * Gère le cas de l'antiméridien : si bboxWest > bboxEast, la zone traverse
 * l'antiméridien (ex: west=170, east=-170). Dans ce cas, le point est inclus
 * si longitude >= bboxWest OU longitude <= bboxEast.
 *
 * @param latitude  latitude du point (degrés décimaux)
 * @param longitude longitude du point (degrés décimaux)
 * @param bboxSouth borne sud de la bbox
 * @param bboxWest  borne ouest de la bbox
 * @param bboxNorth borne nord de la bbox
 * @param bboxEast  borne est de la bbox
 */
export function isPointInBbox(
  latitude: number,
  longitude: number,
  bboxSouth: number,
  bboxWest: number,
  bboxNorth: number,
  bboxEast: number,
): boolean {
  // Vérification latitude (toujours south < north).
  if (latitude < bboxSouth || latitude > bboxNorth) return false;

  // Vérification longitude.
  if (bboxWest <= bboxEast) {
    // Cas normal : la bbox ne traverse pas l'antiméridien.
    return longitude >= bboxWest && longitude <= bboxEast;
  } else {
    // Cas antiméridien : la bbox traverse le +/-180.
    return longitude >= bboxWest || longitude <= bboxEast;
  }
}

/**
 * Classe une offre géographique sans mélanger une alternative de rayon avec
 * une destination exacte ou un viewport choisi explicitement.
 */
export function classifyPublicSearchGeographicMatch(params: {
  latitude: number;
  longitude: number;
  destinationBbox: {
    south: number;
    west: number;
    north: number;
    east: number;
  };
  rawDistanceMeters: number;
  areaKind: 'DESTINATION_RADIUS' | 'VIEWPORT';
}): PublicSearchGeographicMatch {
  const { latitude, longitude, destinationBbox, rawDistanceMeters, areaKind } = params;
  if (
    isPointInBbox(
      latitude,
      longitude,
      destinationBbox.south,
      destinationBbox.west,
      destinationBbox.north,
      destinationBbox.east,
    )
  ) {
    return 'EXACT';
  }
  if (areaKind === 'VIEWPORT') return 'VIEWPORT_ALTERNATIVE';

  return (
    PUBLIC_SEARCH_RADIUS_TIERS.find((tier) => rawDistanceMeters <= tier.meters)?.match ??
    'RADIUS_50KM'
  );
}

/**
 * Calcule la distance haversine approximative en mètres entre deux points
 * (latitude, longitude) en degrés décimaux.
 *
 * Utilisé UNIQUEMENT côté TypeScript pour le tri et le curseur lorsque
 * la distance n'est pas déjà calculée par PostgreSQL. Dans le chemin nominal,
 * la distance est calculée par PostgreSQL via ST_Distance(geography).
 *
 * Rayon de la Terre : 6371000 mètres (sphère WGS84 approximée).
 */
export function haversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000; // mètres
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Arrondit une distance en mètres pour l'affichage public.
 * La précision brute (rawDistanceMeters) est conservée pour le tri et le curseur.
 */
export function roundDistanceForDisplay(rawDistanceMeters: number): number {
  return Math.round(rawDistanceMeters);
}
