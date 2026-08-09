/**
 * @uttily/core — Validation stricte du providerMessageId (G5E Round 3, ADR-013 §11).
 *
 * Parseur PUR et FERMÉ : aucune dépendance externe, aucun effet de bord.
 * Les messages d'erreur ne contiennent JAMAIS la valeur reçue (confidentialité).
 *
 * Règles de validation :
 * 1. Type string obligatoire.
 * 2. Trim obligatoire (pas d'espaces en début/fin).
 * 3. Non vide après trim.
 * 4. Longueur ≤ 256 caractères (documenté).
 * 5. Aucun caractère de contrôle (code < 0x20) ni newline (\n, \r).
 */

/**
 * Valide et normalise un providerMessageId.
 *
 * @param raw La valeur brute reçue depuis le fournisseur.
 * @returns Le providerMessageId validé et trimé.
 * @throws Error('PROVIDER_MESSAGE_ID_INVALID: ...') si invalide.
 *         Les messages d'erreur ne contiennent JAMAIS la valeur reçue.
 */
export function parseProviderMessageId(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error('PROVIDER_MESSAGE_ID_INVALID: type incorrect');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error('PROVIDER_MESSAGE_ID_INVALID: vide');
  }
  if (trimmed.length > 256) {
    throw new Error('PROVIDER_MESSAGE_ID_INVALID: trop long');
  }
  // No control characters (code < 0x20) and no newline (\n, \r).
  if (/[\x00-\x1F\n\r]/.test(trimmed)) {
    throw new Error('PROVIDER_MESSAGE_ID_INVALID: caractère de contrôle');
  }
  return trimmed;
}
