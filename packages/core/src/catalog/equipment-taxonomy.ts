/**
 * Registre serveur fermé des familles d'équipements Uttily.
 *
 * Ce contrat décrit le périmètre commercial et ne remplace pas la taxonomie
 * globale stockée en base. Le registre ne déplace aucune règle de publication,
 * de disponibilité, de tarification ou de permission dans la présentation.
 */

export const EQUIPMENT_UNIVERSE_SLUGS = ['cycle', 'paddle', 'surf', 'snow'] as const;
export type EquipmentUniverseSlug = (typeof EQUIPMENT_UNIVERSE_SLUGS)[number];

export interface EquipmentUniverseDefinition {
  readonly slug: EquipmentUniverseSlug;
  readonly label: string;
}

export const EQUIPMENT_FAMILY_STATUSES = [
  'ACTIVE',
  'APPROVED_NEXT',
  'APPROVED_LATER',
  'INTERNAL_FALLBACK',
] as const;
export type EquipmentFamilyStatus = (typeof EQUIPMENT_FAMILY_STATUSES)[number];

export const ACCESSORY_MODES = [
  'INCLUDED',
  'MANDATORY',
  'OPTIONAL_FREE',
  'PAID_SUPPLEMENT',
  'SEPARATELY_RENTABLE',
] as const;
export type AccessoryMode = (typeof ACCESSORY_MODES)[number];

export const ACCESSORY_STANDALONE_PUBLICATION_DEFAULT = 'DISABLED_BY_DEFAULT' as const;

/**
 * Contrat canonique de la famille paddleboard.
 *
 * `paddle` est conservé comme slug historique dans certaines bases et ne doit
 * jamais être promu implicitement. La famille commerciale active utilise
 * exclusivement `paddleboard`.
 */
export const PADDLEBOARD_CATEGORY_SLUG = 'paddleboard' as const;
export const HISTORICAL_PADDLE_CATEGORY_SLUG = 'paddle' as const;
export const PADDLE_CATEGORY_CONTRACT = Object.freeze({
  canonicalSlug: PADDLEBOARD_CATEGORY_SLUG,
  status: 'ACTIVE',
  historicalStorageSlugs: [HISTORICAL_PADDLE_CATEGORY_SLUG] as const,
});

export type PaddleCategoryStatus = typeof PADDLE_CATEGORY_CONTRACT.status;

export function isHistoricalPaddleCategorySlug(slug: string | null | undefined): boolean {
  return slug === HISTORICAL_PADDLE_CATEGORY_SLUG;
}

export function isPaddleCategorySlug(slug: string | null | undefined): boolean {
  return slug === PADDLEBOARD_CATEGORY_SLUG || isHistoricalPaddleCategorySlug(slug);
}

export interface EquipmentCharacteristicDefinition {
  readonly key: string;
  readonly allowedValues?: readonly string[];
}

export type EquipmentFamilySlug =
  | 'bike'
  | 'kayak'
  | 'canoe'
  | 'paddleboard'
  | 'pedalboat'
  | 'surf'
  | 'ski'
  | 'snowboard'
  | 'equipment';
export type CommercialEquipmentFamilySlug = Exclude<EquipmentFamilySlug, 'equipment'>;

export interface EquipmentFamilyDefinition {
  readonly slug: EquipmentFamilySlug;
  readonly universe: EquipmentUniverseSlug | null;
  readonly status: EquipmentFamilyStatus;
  readonly singularLabel: string;
  readonly pluralLabel: string;
  /** Sous-types descriptifs, jamais des catégories commerciales séparées. */
  readonly subtypes: readonly string[];
  /** Caractéristiques descriptives, sans slug de catégorie enfant. */
  readonly characteristics: readonly EquipmentCharacteristicDefinition[];
}

export const EQUIPMENT_UNIVERSE_REGISTRY: readonly EquipmentUniverseDefinition[] = Object.freeze([
  { slug: 'cycle', label: 'Cycle' },
  { slug: 'paddle', label: 'Kayak, canoë et pagaie' },
  { slug: 'surf', label: 'Surf et glisse nautique' },
  { slug: 'snow', label: 'Neige et glisse' },
]);

export const EQUIPMENT_FAMILY_REGISTRY: readonly EquipmentFamilyDefinition[] = Object.freeze([
  {
    slug: 'bike',
    universe: 'cycle',
    status: 'ACTIVE',
    singularLabel: 'vélo',
    pluralLabel: 'vélos',
    subtypes: [
      'city',
      'vtc',
      'mtb',
      'road',
      'gravel',
      'electric',
      'cargo',
      'child',
      'tandem',
      'fatbike',
    ],
    characteristics: [{ key: 'size' }, { key: 'autonomy' }],
  },
  {
    slug: 'kayak',
    universe: 'paddle',
    status: 'ACTIVE',
    singularLabel: 'kayak',
    pluralLabel: 'kayaks',
    subtypes: [],
    characteristics: [
      { key: 'capacity' },
      { key: 'construction', allowedValues: ['rigid', 'inflatable'] },
      { key: 'practice', allowedValues: ['sea', 'touring', 'whitewater'] },
    ],
  },
  {
    slug: 'canoe',
    universe: 'paddle',
    status: 'ACTIVE',
    singularLabel: 'canoë',
    pluralLabel: 'canoës',
    subtypes: [],
    characteristics: [],
  },
  {
    slug: 'paddleboard',
    universe: 'paddle',
    status: 'ACTIVE',
    singularLabel: 'paddle',
    pluralLabel: 'paddles',
    subtypes: [],
    characteristics: [
      { key: 'capacity', allowedValues: ['single', 'tandem'] },
      { key: 'construction', allowedValues: ['rigid', 'inflatable'] },
    ],
  },
  {
    slug: 'pedalboat',
    universe: 'paddle',
    status: 'ACTIVE',
    singularLabel: 'pédalo',
    pluralLabel: 'pédalos',
    subtypes: [],
    characteristics: [{ key: 'capacity' }],
  },
  {
    slug: 'surf',
    universe: 'surf',
    status: 'ACTIVE',
    singularLabel: 'planche de surf',
    pluralLabel: 'planches de surf',
    subtypes: ['classic', 'longboard', 'softboard', 'bodyboard', 'skimboard'],
    characteristics: [],
  },
  {
    slug: 'ski',
    universe: 'snow',
    status: 'ACTIVE',
    singularLabel: 'ski',
    pluralLabel: 'skis',
    subtypes: ['alpine', 'touring', 'cross-country'],
    characteristics: [],
  },
  {
    slug: 'snowboard',
    universe: 'snow',
    status: 'ACTIVE',
    singularLabel: 'snowboard',
    pluralLabel: 'snowboards',
    subtypes: [],
    characteristics: [],
  },
  {
    slug: 'equipment',
    universe: null,
    status: 'INTERNAL_FALLBACK',
    singularLabel: 'équipement',
    pluralLabel: 'équipements',
    subtypes: [],
    characteristics: [],
  },
]);

/** Slugs commerciaux actuellement publiables, dérivés du registre fermé. */
export const COMMERCIAL_EQUIPMENT_FAMILY_SLUGS: readonly CommercialEquipmentFamilySlug[] =
  Object.freeze(
    EQUIPMENT_FAMILY_REGISTRY.filter(
      (family) => family.status === 'ACTIVE' && family.slug !== 'equipment',
    ).map((family) => family.slug as CommercialEquipmentFamilySlug),
  );

export const CLOSED_OUTDOOR_EQUIPMENT_TAXONOMY = Object.freeze({
  universes: EQUIPMENT_UNIVERSE_REGISTRY,
  families: EQUIPMENT_FAMILY_REGISTRY,
  accessoryModes: ACCESSORY_MODES,
  accessoryStandalonePublicationDefault: ACCESSORY_STANDALONE_PUBLICATION_DEFAULT,
});

const FAMILY_BY_SLUG: ReadonlyMap<string, EquipmentFamilyDefinition> = new Map(
  EQUIPMENT_FAMILY_REGISTRY.map((family) => [family.slug, family] as const),
);

export interface SupportedEquipmentFamilyResolution {
  readonly kind: 'SUPPORTED';
  readonly definition: EquipmentFamilyDefinition;
}

export interface UnsupportedEquipmentFamilyResolution {
  readonly kind: 'UNSUPPORTED';
  readonly slug: string | null;
}

export type EquipmentFamilyResolution =
  SupportedEquipmentFamilyResolution | UnsupportedEquipmentFamilyResolution;

/** Résout uniquement les slugs canoniques du registre fermé. */
export function resolveEquipmentFamily(slug: string | null | undefined): EquipmentFamilyResolution {
  if (typeof slug !== 'string' || slug.length === 0) {
    return { kind: 'UNSUPPORTED', slug: slug ?? null };
  }

  const definition = FAMILY_BY_SLUG.get(slug);
  return definition ? { kind: 'SUPPORTED', definition } : { kind: 'UNSUPPORTED', slug };
}

/** Le fallback technique et les familles seulement approuvées restent inactifs. */
export function isCommerciallyActiveEquipmentFamily(
  slug: string | null | undefined,
): slug is CommercialEquipmentFamilySlug {
  const resolution = resolveEquipmentFamily(slug);
  return resolution.kind === 'SUPPORTED' && resolution.definition.status === 'ACTIVE';
}
