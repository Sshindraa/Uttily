export type PublicLabelLocale = 'fr' | 'en';

const MVP_CATEGORY_LABELS_EN: Readonly<Record<string, string>> = {
  equipment: 'Equipment',
  kayak: 'Kayak',
  canoe: 'Canoe',
  pedalboat: 'Pedal boat',
  surf: 'Surf',
  bodyboard: 'Bodyboard',
  wingfoil: 'Wingfoil',
  paddle: 'Paddleboarding',
  paddleboard: 'Stand-up paddle',
  bike: 'Bikes',
  ski: 'Ski',
  snowboard: 'Snowboard',
  snowshoes: 'Snowshoes',
  sled: 'Sled',
  camping: 'Camping & Outdoor',
  climbing: 'Climbing',
  diving: 'Diving',
  other: 'Other',
};

const MVP_CATEGORY_LABELS_FR: Readonly<Record<string, string>> = {
  kayak: 'Kayak',
  canoe: 'Canoë',
  pedalboat: 'Pédalo',
  paddleboard: 'Paddle',
  bodyboard: 'Bodyboard',
  wingfoil: 'Wingfoil',
  ski: 'Ski',
  snowboard: 'Snowboard',
  snowshoes: 'Raquettes',
  sled: 'Luge',
};

/** Les slugs de la taxonomie MVP sont les clés stables de présentation. */
export function getPublicCategoryLabel(
  locale: PublicLabelLocale,
  category: { slug: string; name: string },
): string {
  if (locale === 'fr') return MVP_CATEGORY_LABELS_FR[category.slug] ?? category.name;
  return MVP_CATEGORY_LABELS_EN[category.slug] ?? category.name;
}
