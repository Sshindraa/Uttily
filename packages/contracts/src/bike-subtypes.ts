/**
 * Sous-types de vélo exposés dans la recherche publique.
 *
 * Ces valeurs décrivent une variante de la famille commerciale `bike` ; elles
 * ne constituent pas des catégories commerciales séparées.
 */
export const BIKE_SUBTYPE_DEFINITIONS = [
  {
    slug: 'mtb',
    labelFr: 'VTT',
    labelEn: 'Mountain bike',
    aliases: ['vtt', 'mtb', 'mountain bike', 'mountain bikes', 'vélo tout terrain'],
  },
  {
    slug: 'city',
    labelFr: 'Vélo de ville',
    labelEn: 'City bike',
    aliases: [
      'vélo de ville',
      'velo de ville',
      'city bike',
      'city bicycle',
      'commuter bike',
      'urban bike',
    ],
  },
  {
    slug: 'road',
    labelFr: 'Vélo de route',
    labelEn: 'Road bike',
    aliases: ['vélo de route', 'velo de route', 'velo route', 'road bike', 'road bikes'],
  },
  {
    slug: 'cargo',
    labelFr: 'Vélo cargo',
    labelEn: 'Cargo bike',
    aliases: ['vélo cargo', 'velo cargo', 'cargo bike', 'cargo bicycle', 'freight bike'],
  },
] as const;

export type BikeSubtype = (typeof BIKE_SUBTYPE_DEFINITIONS)[number]['slug'];

export const BIKE_SUBTYPE_SLUGS: readonly BikeSubtype[] = BIKE_SUBTYPE_DEFINITIONS.map(
  ({ slug }) => slug,
);

export function isBikeSubtype(value: string | null | undefined): value is BikeSubtype {
  return BIKE_SUBTYPE_SLUGS.includes(value as BikeSubtype);
}

export function getBikeSubtypeLabel(locale: 'fr' | 'en', subtype: BikeSubtype): string {
  const definition = BIKE_SUBTYPE_DEFINITIONS.find((item) => item.slug === subtype);
  return locale === 'fr' ? definition!.labelFr : definition!.labelEn;
}

function normalizeBikeSubtypeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Résout une saisie humaine vers un slug de sous-type canonique. */
export function normalizeBikeSubtype(value: string | null | undefined): BikeSubtype | null {
  const normalized = normalizeBikeSubtypeText(value ?? '');
  if (!normalized) return null;

  const definition = BIKE_SUBTYPE_DEFINITIONS.find(
    (item) =>
      item.slug === normalized ||
      normalizeBikeSubtypeText(item.labelFr) === normalized ||
      normalizeBikeSubtypeText(item.labelEn) === normalized ||
      item.aliases.some((alias) => normalizeBikeSubtypeText(alias) === normalized),
  );
  return definition?.slug ?? null;
}
