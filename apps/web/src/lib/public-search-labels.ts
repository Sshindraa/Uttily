export type PublicLabelLocale = 'fr' | 'en';

const MVP_CATEGORY_LABELS_EN: Readonly<Record<string, string>> = {
  equipment: 'Equipment',
  kayak: 'Kayak',
  surf: 'Surf',
  paddle: 'Paddleboarding',
  bike: 'Bikes',
  ski: 'Ski',
  snowboard: 'Snowboard',
  camping: 'Camping & Outdoor',
  climbing: 'Climbing',
  diving: 'Diving',
  other: 'Other',
};

const MVP_CATEGORY_LABELS_FR: Readonly<Record<string, string>> = {
  kayak: 'Kayak',
  ski: 'Ski',
  snowboard: 'Snowboard',
};

/** Les slugs de la taxonomie MVP sont les clés stables de présentation. */
export function getPublicCategoryLabel(
  locale: PublicLabelLocale,
  category: { slug: string; name: string },
): string {
  if (locale === 'fr') return MVP_CATEGORY_LABELS_FR[category.slug] ?? category.name;
  return MVP_CATEGORY_LABELS_EN[category.slug] ?? category.name;
}
