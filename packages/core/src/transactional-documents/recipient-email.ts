/**
 * @uttily/core — Validation stricte de l'email du destinataire (G5E Round 2, ADR-013 §11).
 *
 * Parseur PUR et FERMÉ : aucune dépendance externe, aucun effet de bord.
 * Les messages d'erreur ne contiennent JAMAIS la valeur reçue (confidentialité).
 *
 * Règles de validation :
 * 1. Type string obligatoire.
 * 2. Trim obligatoire (pas d'espaces en début/fin).
 * 3. Non vide après trim.
 * 4. Longueur ≤ 254 caractères (RFC 5321).
 * 5. Aucun caractère de contrôle ni espace interne.
 * 6. Exactement un caractère '@'.
 * 7. Partie locale non vide, ≤ 64 caractères (RFC 5321).
 * 8. Domaine non vide, ≤ 253 caractères.
 * 9. Domaine doit contenir au moins un point.
 * 10. Pas de points consécutifs (local ni domaine).
 */

/**
 * Valide et normalise un email de destinataire.
 *
 * @param raw La valeur brute lue depuis la DB ou l'input.
 * @returns L'email validé et trimé.
 * @throws Error('RECIPIENT_EMAIL_INVALID: ...') si invalide.
 *         Les messages d'erreur ne contiennent JAMAIS la valeur reçue.
 */
export function parseRecipientEmail(raw: string): string {
  if (typeof raw !== 'string') {
    throw new Error('RECIPIENT_EMAIL_INVALID: type incorrect');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error('RECIPIENT_EMAIL_INVALID: vide');
  }
  if (trimmed.length > 254) {
    throw new Error('RECIPIENT_EMAIL_INVALID: trop long');
  }
  // No whitespace or control characters.
  if (/\s/.test(trimmed) || /[\x00-\x1F\x7F]/.test(trimmed)) {
    throw new Error('RECIPIENT_EMAIL_INVALID: caractère interdit');
  }
  // Exactly one @.
  const atIndex = trimmed.indexOf('@');
  if (atIndex < 1) {
    throw new Error('RECIPIENT_EMAIL_INVALID: format local@domaine');
  }
  if (trimmed.lastIndexOf('@') !== atIndex) {
    throw new Error('RECIPIENT_EMAIL_INVALID: multiple @');
  }
  const local = trimmed.substring(0, atIndex);
  const domain = trimmed.substring(atIndex + 1);
  if (local.length === 0 || local.length > 64) {
    throw new Error('RECIPIENT_EMAIL_INVALID: partie locale invalide');
  }
  if (domain.length === 0 || domain.length > 253) {
    throw new Error('RECIPIENT_EMAIL_INVALID: domaine invalide');
  }
  // Domain must contain at least one dot.
  if (!domain.includes('.')) {
    throw new Error('RECIPIENT_EMAIL_INVALID: domaine sans point');
  }
  // No consecutive dots.
  if (local.includes('..') || domain.includes('..')) {
    throw new Error('RECIPIENT_EMAIL_INVALID: points consécutifs');
  }
  return trimmed;
}
