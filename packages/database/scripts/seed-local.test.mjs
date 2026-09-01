import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { assertLocalSeedEnvironment, isLocalSeedEnvironment } from './seed-local.mjs';

const seedSource = readFileSync(new URL('./seed-local.mjs', import.meta.url), 'utf8');

describe('seed local environment guards', () => {
  it('refuse le seed sans marqueur local explicite', () => {
    const environment = { NODE_ENV: 'development' };

    expect(isLocalSeedEnvironment(environment)).toBe(false);
    expect(() => assertLocalSeedEnvironment(environment)).toThrow(
      /seed local exige un environnement de développement local explicite/i,
    );
  });

  it('refuse le seed si NODE_ENV est absent ou différent de development', () => {
    const invalidEnvironments = [
      { UTTILY_LOCAL_DEV: '1' },
      { NODE_ENV: 'test', UTTILY_LOCAL_DEV: '1' },
      { NODE_ENV: 'staging', UTTILY_LOCAL_DEV: '1' },
      { NODE_ENV: 'production', UTTILY_LOCAL_DEV: '1' },
    ];

    for (const environment of invalidEnvironments) {
      expect(isLocalSeedEnvironment(environment)).toBe(false);
      expect(() => assertLocalSeedEnvironment(environment)).toThrow(
        /seed local exige un environnement de développement local explicite/i,
      );
    }
  });

  it('autorise uniquement le couple local development explicite', () => {
    const environment = { NODE_ENV: 'development', UTTILY_LOCAL_DEV: '1' };

    expect(isLocalSeedEnvironment(environment)).toBe(true);
    expect(() => assertLocalSeedEnvironment(environment)).not.toThrow();
  });

  it('ne publie pas de fixture avec des photos R2 fictives', () => {
    expect(seedSource).not.toContain('DEMO_PHOTOS');
    expect(seedSource).not.toContain('dev-kayak-');
    expect(seedSource).not.toContain('"publication_status" = \'PUBLISHED\'');
    expect(seedSource).toContain('draft; upload real photos to publish');
  });

  it('prépare les deux destinations locales utilisées par les parcours de recherche', () => {
    expect(seedSource).toContain("slug: 'lyon-dev'");
    expect(seedSource).toContain("slug: 'annecy-dev'");
    expect(seedSource).toContain("label: 'Annecy'");
    expect(seedSource).toContain("slug: 'lyon-shop-dev'");
    expect(seedSource).toContain("slug: 'annecy-shop-dev'");
  });

  it('la publication synthétique est isolée dans le seed de preview', () => {
    expect(seedSource).not.toContain('local-preview-kayak-dev');
    expect(seedSource).toContain('product=kayak-dev (draft; upload real photos to publish)');
  });

  it('utilise la catégorie kayak uniquement pour la fixture kayak-dev', () => {
    expect(seedSource).toContain("VALUES ('canoe', 'Canoës', true)");
    expect(seedSource).toContain("VALUES ('kayak', 'Kayaks', true)");
    expect(seedSource).toContain("VALUES ('paddleboard', 'Paddle', true)");
    expect(seedSource).toContain("const DEMO_PRODUCT_SLUG = 'kayak-dev'");
    expect(seedSource).toContain('produit historique utilisant la catégorie equipment');
  });
});
