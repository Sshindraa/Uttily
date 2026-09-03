import { describe, it, expect } from 'vitest';
import {
  cleanRegistrationNumber,
  isValidLuhn,
  isValidFrenchSiretOrSiren,
  computeFrenchVatNumber,
  isValidVatNumber,
  validateOrganizationLegalInput,
} from './legal-identity-validation';

describe('Legal Identity Validation (Lot 21-O1)', () => {
  describe('cleanRegistrationNumber', () => {
    it('nettoie les espaces, tirets et points', () => {
      expect(cleanRegistrationNumber(' 834 728 109 00012 ')).toBe('83472810900012');
      expect(cleanRegistrationNumber('834-728-109')).toBe('834728109');
      expect(cleanRegistrationNumber('')).toBeNull();
      expect(cleanRegistrationNumber(null)).toBeNull();
    });
  });

  describe('isValidLuhn', () => {
    it('valide des séquences de Luhn exactes', () => {
      // 834728109 est un SIREN valide (ex. doctolib: 800902298, etc.)
      expect(isValidLuhn('800902298')).toBe(true);
      expect(isValidLuhn('800902299')).toBe(false); // erroné
    });
  });

  describe('isValidFrenchSiretOrSiren', () => {
    // Exemple réel d'entreprise : SIREN 800 902 298
    // SIRET siège (NIC 00028) : 800 902 298 00028 -> vérifions si valide Luhn
    it('valide un SIREN 9 chiffres conforme', () => {
      expect(isValidFrenchSiretOrSiren('800 902 298')).toBe(true);
    });

    it('rejette un numéro dont la longueur n’est ni 9 ni 14 chiffres', () => {
      expect(isValidFrenchSiretOrSiren('12345')).toBe(false);
      expect(isValidFrenchSiretOrSiren('1234567890')).toBe(false);
    });

    it('rejette un SIREN avec mauvaise clé de Luhn', () => {
      expect(isValidFrenchSiretOrSiren('800 902 299')).toBe(false);
    });

    it('valide un SIRET 14 chiffres conforme (SIREN et SIRET valides)', () => {
      // SIREN : 732 829 320, NIC : 00074 -> SIRET : 732 829 320 00074 (Exemple officiel INSEE)
      expect(isValidFrenchSiretOrSiren('732 829 320 00074')).toBe(true);
    });
  });

  describe('computeFrenchVatNumber', () => {
    it('calcule le bon numéro de TVA français pour un SIREN', () => {
      // SIREN 732829320 -> 732829320 % 97 = 43. (12 + 3 * 43) % 97 = 141 % 97 = 44.
      expect(computeFrenchVatNumber('732 829 320')).toBe('FR44732829320');
      // Vérification que le numéro calculé est validé par isValidVatNumber
      expect(isValidVatNumber('FR44732829320')).toBe(true);
    });

    it('calcule également le numéro de TVA à partir d’un SIRET 14 chiffres', () => {
      expect(computeFrenchVatNumber('732 829 320 00074')).toBe('FR44732829320');
    });

    it('retourne null si la chaîne est invalide', () => {
      expect(computeFrenchVatNumber('123')).toBeNull();
    });
  });

  describe('isValidVatNumber', () => {
    it('valide un numéro français valide', () => {
      expect(isValidVatNumber('FR44732829320')).toBe(true);
    });

    it('rejette un numéro français avec une fausse clé', () => {
      expect(isValidVatNumber('FR99732829320')).toBe(false);
    });

    it('valide un numéro européen standard', () => {
      expect(isValidVatNumber('DE123456789')).toBe(true);
      expect(isValidVatNumber('ESB12345678')).toBe(true);
    });

    it('rejette un numéro sans préfixe pays', () => {
      expect(isValidVatNumber('123456789')).toBe(false);
    });
  });

  describe('validateOrganizationLegalInput', () => {
    it('valide un payload légal complet et net', () => {
      const result = validateOrganizationLegalInput({
        legalName: 'Outdoor Rent SAS',
        publicDisplayName: 'Les Vélos du Lac',
        legalForm: 'SAS',
        registrationNumber: '732 829 320 00074',
        vatNumber: 'FR44732829320',
        registryCity: 'Annecy',
        capitalAmount: '10 000 €',
        legalRepresentativeName: 'Camille Martin',
        registeredOfficeAddress: '15 Quai de la Tournette',
        registeredOfficePostalCode: '74000',
        registeredOfficeCity: 'Annecy',
        registeredOfficeCountryCode: 'FR',
      });

      expect(result.isValid).toBe(true);
      expect(result.fieldErrors).toEqual({});
      expect(result.cleaned.registrationNumber).toBe('73282932000074');
      expect(result.cleaned.legalForm).toBe('SAS');
      expect(result.cleaned.registeredOfficeCity).toBe('Annecy');
    });

    it('remonte des erreurs spécifiques par champ sur données corrompues', () => {
      const result = validateOrganizationLegalInput({
        legalName: 'A', // trop court
        registrationNumber: '111111111', // faux Luhn
        vatNumber: 'FR00111111111', // fausse clé
        registeredOfficePostalCode: '740', // mauvais code postal
        registeredOfficeCountryCode: 'FRANCE', // trop long
      });

      expect(result.isValid).toBe(false);
      expect(result.fieldErrors.legalName).toBeDefined();
      expect(result.fieldErrors.registrationNumber).toBeDefined();
      expect(result.fieldErrors.vatNumber).toBeDefined();
      expect(result.fieldErrors.registeredOfficePostalCode).toBeDefined();
      expect(result.fieldErrors.registeredOfficeCountryCode).toBeDefined();
    });
  });
});
