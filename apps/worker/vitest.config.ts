import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Les tests d'intégration PostgreSQL créent une base de test et
    // appliquent les migrations dans beforeAll ; ce hook peut dépasser
    // le timeout par défaut de 10s sur une machine locale froide.
    hookTimeout: 60000,
    testTimeout: 30000,
    // Plusieurs tests de reproductibilité dans
    // src/adapters/pdf-lib-reproducibility.test.ts et le beforeAll build dans
    // src/smoke-harness.test.ts font tous rmSync + recreate le répertoire
    // partagé apps/worker/dist. Le parallélisme inter-fichiers par défaut de
    // Vitest cause une race sur dist ; la sérialisation inter-fichiers est
    // requise.
    fileParallelism: false,
  },
});
