/**
 * @uttily/core — Fonctions de validation et calcul d'identité légale et fiscale d'entreprise.
 * Conforme aux obligations légales françaises (SIREN, SIRET, TVA intracommunautaire, RCS).
 */

/**
 * Nettoie une chaîne SIREN ou SIRET en supprimant les espaces et tirets éventuels.
 */
export function cleanRegistrationNumber(input?: string | null): string | null {
  if (!input) return null;
  const cleaned = input.replace(/[\s.-]/g, '').trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Algorithme de contrôle de Luhn (standard officiel INSEE pour SIREN et SIRET).
 */
export function isValidLuhn(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;

  let sum = 0;
  let shouldDouble = false;

  // Parcours de droite à gauche
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits.charAt(i), 10);

    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

/**
 * Vérifie si un numéro d'immatriculation français est un SIREN (9 chiffres)
 * ou un SIRET (14 chiffres) valide selon l'algorithme de Luhn.
 */
export function isValidFrenchSiretOrSiren(input?: string | null): boolean {
  const cleaned = cleanRegistrationNumber(input);
  if (!cleaned) return false;

  // Doit comporter soit 9 chiffres (SIREN), soit 14 chiffres (SIRET)
  if (cleaned.length !== 9 && cleaned.length !== 14) {
    return false;
  }

  // Vérification de Luhn
  if (!isValidLuhn(cleaned)) {
    return false;
  }

  // Pour un SIRET (14 chiffres), les 9 premiers chiffres forment le SIREN qui doit également respecter Luhn
  if (cleaned.length === 14) {
    const siren = cleaned.substring(0, 9);
    if (!isValidLuhn(siren)) {
      return false;
    }
  }

  return true;
}

/**
 * Calcule automatiquement le numéro de TVA intracommunautaire français officiel
 * à partir d'un SIREN (9 chiffres) ou SIRET (14 chiffres).
 * Formule légale française : Clé TVA = (12 + 3 * (SIREN modulo 97)) modulo 97.
 */
export function computeFrenchVatNumber(sirenOrSiret: string): string | null {
  const cleaned = cleanRegistrationNumber(sirenOrSiret);
  if (!cleaned || cleaned.length < 9) return null;

  const sirenStr = cleaned.substring(0, 9);
  if (!/^\d{9}$/.test(sirenStr)) return null;

  const sirenNum = parseInt(sirenStr, 10);
  const key = (12 + 3 * (sirenNum % 97)) % 97;
  const formattedKey = key.toString().padStart(2, '0');

  return `FR${formattedKey}${sirenStr}`;
}

/**
 * Valide un numéro de TVA intracommunautaire (Format général européen ou français).
 */
export function isValidVatNumber(input?: string | null): boolean {
  if (!input) return false;
  const cleaned = input
    .replace(/[\s.-]/g, '')
    .trim()
    .toUpperCase();

  // Doit commencer par 2 lettres majuscules d'un pays UE suivies de 2 à 12 caractères alphanumériques
  if (!/^[A-Z]{2}[0-9A-Z]{2,12}$/.test(cleaned)) {
    return false;
  }

  // Si pays = FR, vérifie la clé selon la formule de l'administration fiscale
  if (cleaned.startsWith('FR')) {
    const afterPrefix = cleaned.substring(2);
    // Cas classique standard : 2 chiffres de clé + 9 chiffres de SIREN
    if (/^\d{11}$/.test(afterPrefix)) {
      const keyProvided = parseInt(afterPrefix.substring(0, 2), 10);
      const sirenStr = afterPrefix.substring(2);
      const sirenNum = parseInt(sirenStr, 10);
      const expectedKey = (12 + 3 * (sirenNum % 97)) % 97;
      return keyProvided === expectedKey;
    }
    // Cas spécifique avec clé alphanumérique : format syntaxique valide
    return true;
  }

  return true;
}

export interface OrganizationLegalInput {
  legalName?: string | null | undefined;
  publicDisplayName?: string | null | undefined;
  legalForm?: string | null | undefined;
  registrationNumber?: string | null | undefined;
  vatNumber?: string | null | undefined;
  registryCity?: string | null | undefined;
  capitalAmount?: string | null | undefined;
  legalRepresentativeName?: string | null | undefined;
  registeredOfficeAddress?: string | null | undefined;
  registeredOfficePostalCode?: string | null | undefined;
  registeredOfficeCity?: string | null | undefined;
  registeredOfficeCountryCode?: string | null | undefined;
}

export interface ValidationResult {
  isValid: boolean;
  fieldErrors: Record<string, string>;
  cleaned: OrganizationLegalInput;
}

/**
 * Valide l'ensemble des champs d'identité légale et fiscale saisis pour une organisation.
 */
export function validateOrganizationLegalInput(input: OrganizationLegalInput): ValidationResult {
  const fieldErrors: Record<string, string> = {};

  const legalName = input.legalName?.trim() ?? null;
  if (legalName !== null && legalName.length < 2) {
    fieldErrors.legalName = 'La raison sociale doit comporter au moins 2 caractères.';
  }

  const publicDisplayName = input.publicDisplayName?.trim() ?? null;

  const registrationNumber = cleanRegistrationNumber(input.registrationNumber);
  if (registrationNumber !== null && !isValidFrenchSiretOrSiren(registrationNumber)) {
    fieldErrors.registrationNumber =
      'Numéro SIRET (14 chiffres) ou SIREN (9 chiffres) invalide selon le contrôle de Luhn.';
  }

  let vatNumber =
    input.vatNumber
      ?.replace(/[\s.-]/g, '')
      .trim()
      .toUpperCase() ?? null;
  if (vatNumber !== null && vatNumber.length > 0) {
    if (!isValidVatNumber(vatNumber)) {
      fieldErrors.vatNumber = 'Numéro de TVA intracommunautaire invalide (ex. FR12345678901).';
    }
  } else {
    vatNumber = null;
  }

  const legalForm = input.legalForm?.trim() ?? null;
  const registryCity = input.registryCity?.trim() ?? null;
  const capitalAmount = input.capitalAmount?.trim() ?? null;
  const legalRepresentativeName = input.legalRepresentativeName?.trim() ?? null;
  const registeredOfficeAddress = input.registeredOfficeAddress?.trim() ?? null;
  const registeredOfficeCity = input.registeredOfficeCity?.trim() ?? null;

  const postalCode = input.registeredOfficePostalCode?.trim() ?? null;
  if (postalCode !== null && postalCode.length > 0) {
    if (!/^\d{5}$/.test(postalCode)) {
      fieldErrors.registeredOfficePostalCode = 'Le code postal doit comporter 5 chiffres.';
    }
  }

  const countryCode = (input.registeredOfficeCountryCode?.trim() ?? 'FR').toUpperCase();
  if (countryCode.length !== 2) {
    fieldErrors.registeredOfficeCountryCode = 'Le code pays doit comporter 2 lettres ISO (ex. FR).';
  }

  return {
    isValid: Object.keys(fieldErrors).length === 0,
    fieldErrors,
    cleaned: {
      legalName,
      publicDisplayName:
        publicDisplayName && publicDisplayName.length > 0 ? publicDisplayName : null,
      legalForm: legalForm && legalForm.length > 0 ? legalForm : null,
      registrationNumber,
      vatNumber,
      registryCity: registryCity && registryCity.length > 0 ? registryCity : null,
      capitalAmount: capitalAmount && capitalAmount.length > 0 ? capitalAmount : null,
      legalRepresentativeName:
        legalRepresentativeName && legalRepresentativeName.length > 0
          ? legalRepresentativeName
          : null,
      registeredOfficeAddress:
        registeredOfficeAddress && registeredOfficeAddress.length > 0
          ? registeredOfficeAddress
          : null,
      registeredOfficePostalCode: postalCode && postalCode.length > 0 ? postalCode : null,
      registeredOfficeCity:
        registeredOfficeCity && registeredOfficeCity.length > 0 ? registeredOfficeCity : null,
      registeredOfficeCountryCode: countryCode,
    },
  };
}
