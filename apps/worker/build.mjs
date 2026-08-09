/**
 * @uttily/worker — Script de build esbuild.
 *
 * Bundule le worker en un artefact Node ESM réellement exécutable, en résolvant
 * les packages workspace (`@uttily/core`, `@uttily/database`, `@uttily/contracts`)
 * qui sont source-only (main: ./src/index.ts) et donc non chargeables par Node.
 *
 * Seules les dépendances npm natives (non-workspace) sont externalisées :
 * `postgres`, `drizzle-orm`, `stripe`. Elles doivent être installées dans
 * node_modules au runtime. `pdf-lib` et `@pdf-lib/fontkit` sont bundled
 * (non externalisées) car le renderer PDF les embarque directement.
 *
 * Tous les chemins sont résolus depuis `import.meta.url` pour garantir que le
 * script fonctionne identiquement depuis la racine du monorepo
 * (`node apps/worker/build.mjs`, `pnpm --filter @uttily/worker build`) ou
 * depuis le répertoire du package. Aucun chemin relatif n'est utilisé pour
 * `rmSync`/`mkdirSync` afin d'éviter toute suppression hors-cible liée au
 * working directory.
 */
import { rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Résolution absolue depuis l'emplacement de ce script.
const workerDirectory = dirname(fileURLToPath(import.meta.url));
const distDirectory = resolve(workerDirectory, 'dist');
const entryPoint = resolve(workerDirectory, 'src/index.ts');

// Vérification défensive : la cible du rmSync doit être exactement
// `<workerDirectory>/dist`. Toute autre valeur (répertoire parent, racine du
// dépôt, etc.) est rejetée avant toute suppression.
if (dirname(distDirectory) !== workerDirectory || basename(distDirectory) !== 'dist') {
  throw new Error(
    `build.mjs: refus de supprimer ${distDirectory} — la cible doit être exactement ` +
      `${workerDirectory}/dist (vérification défensive échouée).`,
  );
}

// Nettoyage du `dist` avant le build pour garantir la reproductibilité :
// seuls les artefacts produits par ce build resteront dans `apps/worker/dist`.
// Aucun fichier sentinelle ou obsolète ne survit. Le répertoire est strictement
// limité à `apps/worker/dist` (chemin absolu validé ci-dessus) — aucun
// répertoire extérieur n'est touché.
rmSync(distDirectory, { recursive: true, force: true });
mkdirSync(distDirectory, { recursive: true });

await build({
  entryPoints: [entryPoint],
  bundle: true,
  platform: 'node',
  format: 'esm',
  mainFields: ['module', 'main'],
  outdir: distDirectory,
  sourcemap: true,
  external: ['postgres', 'drizzle-orm', 'stripe', '@aws-sdk/client-s3', 'resend'],
  logLevel: 'info',
});
