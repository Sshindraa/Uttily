import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    hookTimeout: 120000,
    testTimeout: 120000,
    // Chaque fichier crée une base PostgreSQL dédiée, applique les migrations
    // puis la supprime. Les lancer en parallèle surcharge le serveur local et
    // peut transformer une panne de disponibilité en suite partiellement
    // ignorée. La CI garde son parallélisme entre packages ; Database reste
    // séquentiel à l'intérieur du package.
    fileParallelism: false,
  },
});
