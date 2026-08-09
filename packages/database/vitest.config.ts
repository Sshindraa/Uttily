import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    hookTimeout: 120000,
    testTimeout: 120000,
  },
});
