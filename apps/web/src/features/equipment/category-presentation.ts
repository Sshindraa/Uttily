export interface CategoryCharacteristic {
  readonly key: string;
  readonly label: string;
  readonly aliases?: readonly string[];
  readonly allowedValues?: readonly string[];
}

export interface CategoryPresentation {
  readonly singularLabel: string;
  readonly pluralLabel: string;
  readonly icon: string;
  readonly characteristics: readonly CategoryCharacteristic[];
  readonly specificSections: readonly string[];
  readonly primaryActionLabel: string;
  readonly setupActionLabel: string;
}

export interface ActiveCategoryPresentation {
  readonly slug: string;
  readonly status: 'ACTIVE';
  readonly presentation: CategoryPresentation;
}

// Do not import the server package from client components: this is the
// presentation mirror of the Core contract, not its authority.
const PADDLEBOARD_CATEGORY_SLUG = 'paddleboard';
const HISTORICAL_PADDLE_CATEGORY_SLUG = 'paddle';

function isPaddleCategorySlug(slug: string | null | undefined): boolean {
  return slug === PADDLEBOARD_CATEGORY_SLUG || slug === HISTORICAL_PADDLE_CATEGORY_SLUG;
}

/**
 * Presentation-only configuration. Category rules remain in Core; this map
 * only decides which labels and optional sections the loueur surface exposes.
 */
export const GENERIC_CATEGORY_PRESENTATION: CategoryPresentation = {
  singularLabel: 'équipement',
  pluralLabel: 'équipements',
  icon: '🧰',
  characteristics: [],
  specificSections: [],
  primaryActionLabel: 'Gérer l’équipement',
  setupActionLabel: 'Continuer la configuration',
};

/** Présentation nautique neutre pour les familles sans attribut spécialisé. */
export const GENERIC_WATERCRAFT_CATEGORY_PRESENTATION: CategoryPresentation = {
  singularLabel: 'canoë',
  pluralLabel: 'canoës',
  icon: '🛶',
  characteristics: [],
  specificSections: [],
  primaryActionLabel: 'Gérer l’équipement',
  setupActionLabel: 'Continuer la configuration',
};

/** Présentation active de la famille paddleboard, sans règle métier dédiée. */
export const PADDLEBOARD_CATEGORY_PRESENTATION: ActiveCategoryPresentation = Object.freeze({
  slug: PADDLEBOARD_CATEGORY_SLUG,
  status: 'ACTIVE',
  presentation: Object.freeze({
    singularLabel: 'paddle',
    pluralLabel: 'paddles',
    icon: '🛟',
    characteristics: [
      { key: 'capacity', label: 'Capacité', allowedValues: ['single', 'tandem'] },
      {
        key: 'construction',
        label: 'Construction',
        allowedValues: ['rigid', 'inflatable'],
      },
    ],
    specificSections: [],
    primaryActionLabel: 'Gérer l’équipement',
    setupActionLabel: 'Continuer la configuration',
  }),
});

/** Présentation neutre conservée pour le slug historique `paddle`. */
const HISTORICAL_PADDLE_PRESENTATION: CategoryPresentation = Object.freeze({
  singularLabel: 'paddle',
  pluralLabel: 'paddles',
  icon: '🛟',
  characteristics: [],
  specificSections: [],
  primaryActionLabel: 'Gérer l’équipement',
  setupActionLabel: 'Continuer la configuration',
});

const CATEGORY_PRESENTATIONS: Readonly<Record<string, CategoryPresentation>> = {
  bike: {
    singularLabel: 'vélo',
    pluralLabel: 'vélos',
    icon: '🚲',
    characteristics: [
      { key: 'size', label: 'Taille' },
      { key: 'autonomy', label: 'Autonomie', aliases: ['rangeKm', 'batteryRangeKm'] },
    ],
    specificSections: ['photo-slots', 'safety'],
    primaryActionLabel: 'Gérer l’équipement',
    setupActionLabel: 'Continuer la configuration',
  },
  kayak: {
    singularLabel: 'kayak',
    pluralLabel: 'kayaks',
    icon: '🛶',
    characteristics: [
      { key: 'capacity', label: 'Capacité' },
      {
        key: 'construction',
        label: 'Construction',
        allowedValues: ['rigid', 'inflatable'],
      },
      {
        key: 'practice',
        label: 'Pratique',
        allowedValues: ['sea', 'touring', 'whitewater'],
      },
    ],
    specificSections: [],
    primaryActionLabel: 'Gérer l’équipement',
    setupActionLabel: 'Continuer la configuration',
  },
  canoe: GENERIC_WATERCRAFT_CATEGORY_PRESENTATION,
  surf: {
    singularLabel: 'planche de surf',
    pluralLabel: 'planches de surf',
    icon: '🏄',
    characteristics: [],
    specificSections: [],
    primaryActionLabel: 'Gérer l’équipement',
    setupActionLabel: 'Continuer la configuration',
  },
  ski: {
    singularLabel: 'ski',
    pluralLabel: 'skis',
    icon: '🎿',
    characteristics: [
      {
        key: 'subtype',
        label: 'Sous-type',
        allowedValues: ['alpine', 'touring', 'cross-country'],
      },
    ],
    specificSections: [],
    primaryActionLabel: 'Gérer l’équipement',
    setupActionLabel: 'Continuer la configuration',
  },
  snowboard: {
    singularLabel: 'snowboard',
    pluralLabel: 'snowboards',
    icon: '🏂',
    characteristics: [],
    specificSections: [],
    primaryActionLabel: 'Gérer l’équipement',
    setupActionLabel: 'Continuer la configuration',
  },
  // L'ancien slug reste neutre pour la compatibilité ; seule la famille
  // canonique `paddleboard` reçoit sa présentation active.
  paddle: HISTORICAL_PADDLE_PRESENTATION,
  [PADDLEBOARD_CATEGORY_SLUG]: PADDLEBOARD_CATEGORY_PRESENTATION.presentation,
  equipment: GENERIC_CATEGORY_PRESENTATION,
};

export function getCategoryPresentation(categorySlug?: string | null): CategoryPresentation {
  if (!categorySlug) return GENERIC_CATEGORY_PRESENTATION;
  return CATEGORY_PRESENTATIONS[categorySlug] ?? GENERIC_CATEGORY_PRESENTATION;
}

function displayValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

export function getDisplayableCharacteristics(
  attributes: Record<string, unknown> | null | undefined,
  presentation: CategoryPresentation,
): Array<{ label: string; value: string }> {
  if (!attributes) return [];

  return presentation.characteristics.flatMap((characteristic) => {
    const keys = [characteristic.key, ...(characteristic.aliases ?? [])];
    const value = keys.map((key) => displayValue(attributes[key])).find(Boolean);
    if (value && characteristic.allowedValues && !characteristic.allowedValues.includes(value)) {
      return [];
    }
    return value ? [{ label: characteristic.label, value }] : [];
  });
}

/**
 * Normalise les libellés historiques connus à l’affichage.
 * Le slug reste l’autorité pour éviter qu’un nom stocké incohérent ne brouille
 * la famille présentée.
 */
export function getCategoryDisplayLabel(
  categorySlug: string | null | undefined,
  storedName: string,
): string {
  if (
    categorySlug === 'ski' ||
    categorySlug === 'kayak' ||
    categorySlug === 'canoe' ||
    isPaddleCategorySlug(categorySlug)
  ) {
    return getCategoryPresentation(categorySlug).singularLabel;
  }
  return storedName;
}
