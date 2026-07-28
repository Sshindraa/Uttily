/**
 * Validation des slugs (organisations, établissements).
 * Format : minuscules, chiffres, tirets ; pas de tiret en début/fin ni double tiret.
 */
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_REGEX.test(slug) && slug.length >= 2 && slug.length <= 60;
}

/**
 * Normalise une chaîne en slug (minuscules, accents retirés, espaces → tirets).
 */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
