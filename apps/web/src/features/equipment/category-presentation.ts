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
      { key: 'construction', label: 'Construction' },
      { key: 'practice', label: 'Pratique' },
    ],
    specificSections: [],
    primaryActionLabel: 'Gérer l’équipement',
    setupActionLabel: 'Continuer la configuration',
  },
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
 * Normalise uniquement l’ancien libellé global ski/snowboard à l’affichage.
 * Le slug reste l’autorité : aucune autre famille neige n’est activée.
 */
export function getCategoryDisplayLabel(
  categorySlug: string | null | undefined,
  storedName: string,
): string {
  return categorySlug === 'ski' ? getCategoryPresentation('ski').singularLabel : storedName;
}
