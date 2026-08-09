import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Les tests d'intégration PostgreSQL créent une base de test et
    // appliquent les migrations dans beforeAll ; ce hook peut dépasser
    // le timeout par défaut de 10s sur une machine locale froide.
    hookTimeout: 120000,
    testTimeout: 30000,
  },
});
