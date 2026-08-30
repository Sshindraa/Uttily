const SKU_TOKEN_LENGTH = 12;

/**
 * Construit un SKU d'exemplaire pour une création en bulk.
 *
 * Le token de batch vient de crypto.randomUUID et ne dépend ni de l'heure
 * système ni du nombre d'éléments déjà présents en base. L'unicité finale
 * reste garantie par l'index PostgreSQL de l'organisation.
 */
export function buildInventorySku(
  prefix: string,
  ordinal: number,
  batchId: string,
): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new Error('ordinal doit être un entier strictement positif.');
  }

  const normalizedPrefix = prefix.trim().toUpperCase() || 'VELO';
  const token = batchId.replaceAll('-', '').slice(0, SKU_TOKEN_LENGTH).toUpperCase();
  if (token.length < 8) {
    throw new Error('batchId doit contenir un identifiant suffisamment long.');
  }

  return `${normalizedPrefix}-${token}-${String(ordinal).padStart(3, '0')}`;
}
