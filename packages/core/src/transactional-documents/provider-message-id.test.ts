/**
 * @uttily/core — Tests unitaires du parseur providerMessageId (G5E Round 3, ADR-013 §11).
 *
 * Tests PURS : aucun PostgreSQL requis. Vérifient la validation stricte du
 * providerMessageId et l'absence de la valeur reçue dans les messages d'erreur.
 */

import { describe, expect, it } from 'vitest';
import { parseProviderMessageId } from './provider-message-id';

describe('parseProviderMessageId', () => {
  it('1. valeur valide → retourne la valeur trimée', () => {
    expect(parseProviderMessageId('msg-123')).toBe('msg-123');
  });

  it('2. valeur valide avec espaces environnants → retourne la valeur trimée', () => {
    expect(parseProviderMessageId('  msg-123  ')).toBe('msg-123');
  });

  it('3. espaces uniquement → jette PROVIDER_MESSAGE_ID_INVALID', () => {
    expect(() => parseProviderMessageId('   ')).toThrow('PROVIDER_MESSAGE_ID_INVALID');
  });

  it('4. chaîne vide → jette PROVIDER_MESSAGE_ID_INVALID', () => {
    expect(() => parseProviderMessageId('')).toThrow('PROVIDER_MESSAGE_ID_INVALID');
  });

  it('5. type non-string (null) → jette PROVIDER_MESSAGE_ID_INVALID', () => {
    expect(() => parseProviderMessageId(null)).toThrow('PROVIDER_MESSAGE_ID_INVALID');
  });

  it('6. type non-string (undefined) → jette PROVIDER_MESSAGE_ID_INVALID', () => {
    expect(() => parseProviderMessageId(undefined)).toThrow('PROVIDER_MESSAGE_ID_INVALID');
  });

  it('7. type non-string (number) → jette PROVIDER_MESSAGE_ID_INVALID', () => {
    expect(() => parseProviderMessageId(42)).toThrow('PROVIDER_MESSAGE_ID_INVALID');
  });

  it('8. type non-string (array) → jette PROVIDER_MESSAGE_ID_INVALID', () => {
    expect(() => parseProviderMessageId(['msg-123'])).toThrow('PROVIDER_MESSAGE_ID_INVALID');
  });

  it('9. type non-string (object) → jette PROVIDER_MESSAGE_ID_INVALID', () => {
    expect(() => parseProviderMessageId({ id: 'msg-123' })).toThrow('PROVIDER_MESSAGE_ID_INVALID');
  });

  it('10. caractère de contrôle (\\n) → jette PROVIDER_MESSAGE_ID_INVALID', () => {
    expect(() => parseProviderMessageId('msg\n123')).toThrow('PROVIDER_MESSAGE_ID_INVALID');
  });

  it('11. caractère de contrôle (\\r) → jette PROVIDER_MESSAGE_ID_INVALID', () => {
    expect(() => parseProviderMessageId('msg\r123')).toThrow('PROVIDER_MESSAGE_ID_INVALID');
  });

  it('12. caractère de contrôle (\\x00) → jette PROVIDER_MESSAGE_ID_INVALID', () => {
    expect(() => parseProviderMessageId('msg\x00123')).toThrow('PROVIDER_MESSAGE_ID_INVALID');
  });

  it('13. caractère de contrôle (\\x1F) → jette PROVIDER_MESSAGE_ID_INVALID', () => {
    expect(() => parseProviderMessageId('msg\x1F123')).toThrow('PROVIDER_MESSAGE_ID_INVALID');
  });

  it('14. trop long (> 256 caractères) → jette PROVIDER_MESSAGE_ID_INVALID', () => {
    const longId = 'a'.repeat(257);
    expect(() => parseProviderMessageId(longId)).toThrow('PROVIDER_MESSAGE_ID_INVALID');
  });

  it('15. exactement 256 caractères → valide', () => {
    const exactId = 'a'.repeat(256);
    expect(parseProviderMessageId(exactId)).toBe(exactId);
  });

  it("16. les messages d'erreur ne contiennent JAMAIS la valeur reçue", () => {
    const sensitiveValue = 'SECRET-TOKEN-ABC123';
    try {
      parseProviderMessageId(`  ${sensitiveValue}\n  `);
      expect.fail('Devrait jeter');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(sensitiveValue);
    }
  });

  it("17. les messages d'erreur ne contiennent pas la valeur reçue (trop long)", () => {
    const longValue = 'x'.repeat(300);
    try {
      parseProviderMessageId(longValue);
      expect.fail('Devrait jeter');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(longValue);
    }
  });
});
