/**
 * @uttily/core — Validation pure et fermée d'adresse email (G5E Round 2, ADR-013 §11).
 *
 * Fonction PURE : aucune dépendance SQL, aucun effet de bord, aucune RegExp complexe.
 * Toutes les vérifications sont déterministes et reproductibles.
 *
 * Règles de validation (RFC 5321 simplifié) :
 * 1. Type string.
 * 2. Trim (espaces de début et de fin supprimés).
 * 3. Non vide après trim.
 * 4. Longueur maximale 254 caractères (RFC 5321).
 * 5. Exactement un caractère '@'.
 * 6. Partie locale (avant '@') non vide, sans espaces, sans caractères de contrôle.
 * 7. Domaine (après '@') non vide, sans espaces, sans caractères de contrôle,
 *    au moins un point.
 *
 * Confidentialité :
 * - L'erreur normalisée ne contient JAMAIS la valeur reçue.
 * - Aucun PII dans les messages d'erreur.
 */

/** Longueur maximale d'une adresse email selon RFC 5321. */
const MAX_EMAIL_LENGTH = 254;

/** Code de contrôle : caractères ASCII 0-31 et 127. */
function isControlChar(code: number): boolean {
  return (code >= 0 && code <= 31) || code === 127;
}

/** Vérifie qu'une chaîne ne contient ni espaces ni caractères de contrôle. */
function hasNoSpacesOrControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 32 /* space */ || isControlChar(code)) {
      return false;
    }
  }
  return true;
}

/** Résultat de la validation d'email : succès ou erreur normalisée sans PII. */
export type EmailValidationResult =
  { valid: true; normalizedEmail: string } | { valid: false; error: string };

/**
 * Valide et normalise une adresse email de manière pure et fermée.
 *
 * @param raw Valeur brute reçue (potentiellement non-string, avec espaces, etc.).
 * @returns { valid: true, normalizedEmail } si valide, ou { valid: false, error } sinon.
 *          L'erreur ne contient JAMAIS la valeur reçue.
 */
export function validateAndNormalizeEmail(raw: unknown): EmailValidationResult {
  // 1. Type string.
  if (typeof raw !== 'string') {
    return { valid: false, error: 'INVALID_EMAIL_TYPE' };
  }

  // 2. Trim.
  const trimmed = raw.trim();

  // 3. Non vide après trim.
  if (trimmed.length === 0) {
    return { valid: false, error: 'EMPTY_EMAIL' };
  }

  // 4. Longueur maximale 254 caractères.
  if (trimmed.length > MAX_EMAIL_LENGTH) {
    return { valid: false, error: 'EMAIL_TOO_LONG' };
  }

  // 5. Exactement un caractère '@'.
  const atIndex = trimmed.indexOf('@');
  if (atIndex < 0) {
    return { valid: false, error: 'MISSING_AT_SIGN' };
  }
  if (trimmed.indexOf('@', atIndex + 1) >= 0) {
    return { valid: false, error: 'MULTIPLE_AT_SIGNS' };
  }

  // 6. Partie locale non vide, sans espaces, sans caractères de contrôle.
  const localPart = trimmed.substring(0, atIndex);
  if (localPart.length === 0) {
    return { valid: false, error: 'EMPTY_LOCAL_PART' };
  }
  if (!hasNoSpacesOrControlChars(localPart)) {
    return { valid: false, error: 'INVALID_LOCAL_PART' };
  }

  // 7. Domaine non vide, sans espaces, sans caractères de contrôle, au moins un point.
  const domain = trimmed.substring(atIndex + 1);
  if (domain.length === 0) {
    return { valid: false, error: 'EMPTY_DOMAIN' };
  }
  if (!hasNoSpacesOrControlChars(domain)) {
    return { valid: false, error: 'INVALID_DOMAIN' };
  }
  if (!domain.includes('.')) {
    return { valid: false, error: 'DOMAIN_MISSING_DOT' };
  }

  return { valid: true, normalizedEmail: trimmed };
}
