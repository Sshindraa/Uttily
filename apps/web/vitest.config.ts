import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Alias `@/` vers `src/` pour que Vitest résolve les imports
      // comme `@/lib/catalog-auth` (cohérent avec tsconfig.json paths).
      '@/': fileURLToPath(new URL('./src/', import.meta.url)),
    },
  },
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    // Les tests d'intégration PostgreSQL créent une base de test et
    // appliquent les migrations dans beforeAll ; ce hook peut dépasser
    // le timeout par défaut de 10s sur une machine locale froide.
    hookTimeout: 60000,
    testTimeout: 30000,
  },
});
