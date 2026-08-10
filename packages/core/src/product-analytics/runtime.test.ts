import { describe, expect, it } from 'vitest';
import {
  resolveAnalyticsEnvironment,
  resolveAnalyticsEnvironmentWithDiagnostic,
  type AnalyticsEnvironmentConfig,
} from './runtime';

/**
 * Tests unitaires du resolveur d'environnement analytics (G7H-B).
 * La resolution est pure et injectable — aucun process.env requis.
 */

describe('G7H-B — resolveAnalyticsEnvironment', () => {
  describe('DEVELOPMENT', () => {
    it('retourne DEVELOPMENT pour "DEVELOPMENT"', () => {
      expect(resolveAnalyticsEnvironment({ productAnalyticsEnvironment: 'DEVELOPMENT' })).toBe(
        'DEVELOPMENT',
      );
    });

    it('diagnostic absent pour DEVELOPMENT', () => {
      const result = resolveAnalyticsEnvironmentWithDiagnostic({
        productAnalyticsEnvironment: 'DEVELOPMENT',
      });
      expect(result.environment).toBe('DEVELOPMENT');
      expect(result.diagnostic).toBeUndefined();
    });
  });

  describe('TEST', () => {
    it('retourne TEST pour "TEST"', () => {
      expect(resolveAnalyticsEnvironment({ productAnalyticsEnvironment: 'TEST' })).toBe('TEST');
    });

    it('diagnostic absent pour TEST', () => {
      const result = resolveAnalyticsEnvironmentWithDiagnostic({
        productAnalyticsEnvironment: 'TEST',
      });
      expect(result.environment).toBe('TEST');
      expect(result.diagnostic).toBeUndefined();
    });
  });

  describe('PRODUCTION — toujours DISABLED', () => {
    it('retourne DISABLED pour "PRODUCTION"', () => {
      expect(resolveAnalyticsEnvironment({ productAnalyticsEnvironment: 'PRODUCTION' })).toBe(
        'DISABLED',
      );
    });

    it('diagnostic present pour PRODUCTION', () => {
      const result = resolveAnalyticsEnvironmentWithDiagnostic({
        productAnalyticsEnvironment: 'PRODUCTION',
      });
      expect(result.environment).toBe('DISABLED');
      expect(result.diagnostic).toContain('PRODUCTION');
      expect(result.diagnostic).toContain('bloque');
    });
  });

  describe('valeur absente', () => {
    it('retourne DISABLED pour undefined', () => {
      expect(resolveAnalyticsEnvironment({})).toBe('DISABLED');
    });

    it('retourne DISABLED pour null', () => {
      expect(
        resolveAnalyticsEnvironment({ productAnalyticsEnvironment: null as unknown as string }),
      ).toBe('DISABLED');
    });

    it('retourne DISABLED pour chaine vide', () => {
      expect(resolveAnalyticsEnvironment({ productAnalyticsEnvironment: '' })).toBe('DISABLED');
    });

    it('diagnostic present pour valeur absente', () => {
      const result = resolveAnalyticsEnvironmentWithDiagnostic({});
      expect(result.environment).toBe('DISABLED');
      expect(result.diagnostic).toContain('absent');
    });
  });

  describe('valeur invalide', () => {
    it('retourne DISABLED pour "production" (minuscules)', () => {
      expect(resolveAnalyticsEnvironment({ productAnalyticsEnvironment: 'production' })).toBe(
        'DISABLED',
      );
    });

    it('retourne DISABLED pour "STAGING"', () => {
      expect(resolveAnalyticsEnvironment({ productAnalyticsEnvironment: 'STAGING' })).toBe(
        'DISABLED',
      );
    });

    it('retourne DISABLED pour "LIVE"', () => {
      expect(resolveAnalyticsEnvironment({ productAnalyticsEnvironment: 'LIVE' })).toBe('DISABLED');
    });

    it('retourne DISABLED pour une valeur aleatoire', () => {
      expect(resolveAnalyticsEnvironment({ productAnalyticsEnvironment: 'foobar' })).toBe(
        'DISABLED',
      );
    });

    it('diagnostic present pour valeur invalide', () => {
      const result = resolveAnalyticsEnvironmentWithDiagnostic({
        productAnalyticsEnvironment: 'STAGING',
      });
      expect(result.environment).toBe('DISABLED');
      expect(result.diagnostic).toContain('invalide');
    });
  });

  describe('purete et injectabilite', () => {
    it('la fonction est pure — meme entree, meme sortie', () => {
      const config: AnalyticsEnvironmentConfig = { productAnalyticsEnvironment: 'DEVELOPMENT' };
      expect(resolveAnalyticsEnvironment(config)).toBe(resolveAnalyticsEnvironment(config));
    });

    it('ne lit pas process.env directement', () => {
      // La fonction accepte uniquement un config object, pas process.env.
      // resolveAnalyticsEnvironmentFromProcessEnv est testee separement.
      const original = process.env.PRODUCT_ANALYTICS_ENVIRONMENT;
      process.env.PRODUCT_ANALYTICS_ENVIRONMENT = 'PRODUCTION';
      try {
        // resolveAnalyticsEnvironment ne depend pas de process.env.
        expect(resolveAnalyticsEnvironment({ productAnalyticsEnvironment: 'DEVELOPMENT' })).toBe(
          'DEVELOPMENT',
        );
      } finally {
        if (original === undefined) {
          delete process.env.PRODUCT_ANALYTICS_ENVIRONMENT;
        } else {
          process.env.PRODUCT_ANALYTICS_ENVIRONMENT = original;
        }
      }
    });
  });
});
