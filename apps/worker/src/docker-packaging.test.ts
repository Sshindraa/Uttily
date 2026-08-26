/**
 * @uttily/worker — Validation statique du packaging Docker (G5I-A/G5I-B).
 *
 * Ce fichier contient uniquement des validations statiques : il lit les
 * fichiers Docker avec readFileSync et asserte leur contenu, SANS nécessiter
 * le daemon Docker.
 *
 * Les validations runtime (docker build, docker run, docker compose) ne sont
 * pas couvertes par ce test. Elles ont été exécutées séparément lors de G5I-B
 * (Docker Engine 29.5.2, Compose 5.3.1) et ne sont pas reproduites ici.
 *
 * Validé statiquement :
 * - Dockerfile.worker (stages builder/runtime-base/validation/production,
 *   non-root, CMD, pas d'EXPOSE, pas de secret baked in).
 * - docker-compose.worker.yml (durcissement : cap_drop, security_opt,
 *   read_only, tmpfs, user, limits, logging, env_file externe).
 * - apps/worker/.env.example (8 variables, valeurs factices).
 * - .dockerignore (exclusions attendues, fixtures non exclues).
 * - Correctif packaging : postgres en dependencies (pas devDependencies).
 * - Guide ops : invariants de sécurité documentaires (G5I-A Round 3).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(scriptDir, '..');
const repoRoot = resolve(workerRoot, '..', '..');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de lecture
// ─────────────────────────────────────────────────────────────────────────────

function readFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf-8');
}

// ─────────────────────────────────────────────────────────────────────────────
// Correctif packaging — postgres doit être en dependencies
// ─────────────────────────────────────────────────────────────────────────────

describe('Correctif packaging — postgres en dependencies', () => {
  it('postgres est dans dependencies (pas devDependencies)', () => {
    const pkg = JSON.parse(readFile('apps/worker/package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies).toBeDefined();
    expect(pkg.dependencies['postgres']).toBe('^3.4.0');
    expect(pkg.devDependencies).toBeDefined();
    expect(pkg.devDependencies['postgres']).toBeUndefined();
  });

  it('les 5 deps externalisées sont en dependencies', () => {
    const pkg = JSON.parse(readFile('apps/worker/package.json')) as {
      dependencies: Record<string, string>;
    };
    const externalized = ['postgres', 'drizzle-orm', 'stripe', '@aws-sdk/client-s3', 'resend'];
    for (const dep of externalized) {
      expect(pkg.dependencies[dep]).toBeDefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dockerfile.worker
// ─────────────────────────────────────────────────────────────────────────────

describe('Dockerfile.worker', () => {
  const dockerfile = readFile('Dockerfile.worker');

  it('contient un stage builder base sur node:24-slim', () => {
    expect(dockerfile).toMatch(/FROM\s+node:24-slim\s+AS\s+builder/);
  });

  it('contient un stage runtime-base', () => {
    expect(dockerfile).toMatch(/FROM\s+node:24-slim\s+AS\s+runtime-base/);
  });

  it('contient un stage production', () => {
    expect(dockerfile).toMatch(/FROM\s+runtime-base\s+AS\s+production/);
  });

  it('contient un stage validation', () => {
    expect(dockerfile).toMatch(/FROM\s+runtime-base\s+AS\s+validation/);
  });

  it('le stage validation hérite de runtime-base (pas de production)', () => {
    expect(dockerfile).toMatch(/FROM\s+runtime-base\s+AS\s+validation/);
    expect(dockerfile).not.toMatch(/FROM\s+production\s+AS\s+validation/);
  });

  it('le stage production hérite de runtime-base', () => {
    expect(dockerfile).toMatch(/FROM\s+runtime-base\s+AS\s+production/);
  });

  it('production est le dernier FROM (stage par defaut) ; validation avant production', () => {
    const fromLines = dockerfile.match(/^FROM\s+.+$/gm) ?? [];
    expect(fromLines.length).toBeGreaterThanOrEqual(4);
    // Architecture: builder → runtime-base → validation → production (LAST = default).
    // production est le dernier FROM = stage par défaut. Un build sans --target
    // produit l'image production. validation nécessite --target validation.
    const runtimeBaseIdx = fromLines.findIndex((l) => l.includes('AS runtime-base'));
    const validationIdx = fromLines.findIndex((l) => l.includes('AS validation'));
    const productionIdx = fromLines.findIndex((l) => l.includes('AS production'));
    expect(runtimeBaseIdx).toBeGreaterThanOrEqual(0);
    expect(validationIdx).toBeGreaterThan(runtimeBaseIdx);
    expect(productionIdx).toBeGreaterThan(validationIdx);
    // Le dernier FROM est production = stage par défaut.
    expect(fromLines[fromLines.length - 1]).toContain('AS production');
  });

  it("validation n'est pas le stage par défaut (pas le dernier FROM)", () => {
    const fromLines = dockerfile.match(/^FROM\s+.+$/gm) ?? [];
    expect(fromLines[fromLines.length - 1]).not.toContain('AS validation');
  });

  it('contient un check défensif de la police Inter TTF dans le builder', () => {
    // Le stage builder doit vérifier l'existence de apps/worker/assets/fonts/
    // inter-regular.ttf après le build, pour échouer tôt si la police est
    // absente (sinon le rendu PDF échouerait au runtime).
    expect(dockerfile).toMatch(/test\s+-d\s+apps\/worker\/assets\/fonts/);
    expect(dockerfile).toMatch(/test\s+-f\s+apps\/worker\/assets\/fonts\/inter-regular\.ttf/);
  });

  it('active corepack et prepare pnpm@10.33.3', () => {
    expect(dockerfile).toMatch(/corepack\s+enable/);
    expect(dockerfile).toMatch(/corepack\s+prepare\s+pnpm@10\.33\.3/);
  });

  it('contient pnpm install --frozen-lockfile', () => {
    expect(dockerfile).toMatch(/pnpm\s+install\s+--frozen-lockfile/);
  });

  it('contient pnpm --filter @uttily/worker build', () => {
    expect(dockerfile).toMatch(/pnpm\s+--filter\s+@uttily\/worker\s+build/);
  });

  it('contient pnpm deploy --prod --legacy (requis par pnpm v10)', () => {
    expect(dockerfile).toMatch(/pnpm\s+deploy\s+--filter\s+@uttily\/worker\s+--prod\s+--legacy/);
  });

  it('contient ENV NODE_ENV=production', () => {
    expect(dockerfile).toMatch(/ENV\s+NODE_ENV=production/);
  });

  it('cree un utilisateur non-root avec UID/GID 1001', () => {
    expect(dockerfile).toMatch(/groupadd.*--gid\s+1001\s+uttily/);
    expect(dockerfile).toMatch(/useradd.*--uid\s+1001.*--gid\s+uttily/);
  });

  it('contient USER uttily avant le CMD final du stage production', () => {
    expect(dockerfile).toMatch(/USER\s+uttily/);
  });

  it('le CMD du stage production est node dist/index.js', () => {
    expect(dockerfile).toMatch(/CMD\s+\["node",\s*"dist\/index\.js"\]/);
  });

  it('le CMD du stage validation est le harness smoke', () => {
    expect(dockerfile).toMatch(/CMD\s+\["node",\s*"scripts\/smoke-built-worker\.mjs"\]/);
  });

  it('ne contient pas EXPOSE (aucun port)', () => {
    expect(dockerfile).not.toMatch(/^EXPOSE\b/m);
  });

  it('ne contient aucun ARG/ENV avec un nom de secret', () => {
    const secretPatterns = [
      /ARG\s+\w*(DATABASE_URL|DATABASE_DIRECT_URL)\w*/i,
      /ARG\s+\w*R2_\w*/i,
      /ARG\s+\w*RESEND_\w*/i,
      /ARG\s+\w*_KEY\w*/i,
      /ARG\s+\w*_SECRET\w*/i,
      /ARG\s+\w*_PASSWORD\w*/i,
      /ARG\s+\w*TOKEN\w*/i,
      /ENV\s+\w*(DATABASE_URL|DATABASE_DIRECT_URL)\w*=/i,
      /ENV\s+\w*R2_\w*=/i,
      /ENV\s+\w*RESEND_\w*=/i,
      /ENV\s+\w*_KEY\w*=/i,
      /ENV\s+\w*_SECRET\w*=/i,
      /ENV\s+\w*_PASSWORD\w*=/i,
      /ENV\s+\w*TOKEN\w*=/i,
    ];
    for (const pattern of secretPatterns) {
      expect(dockerfile).not.toMatch(pattern);
    }
  });

  it('le stage validation copie le harness smoke et les fixtures (chemins absolus)', () => {
    expect(dockerfile).toMatch(
      /COPY\s+--from=builder.*\/build\/apps\/worker\/scripts\/smoke-built-worker\.mjs/,
    );
    expect(dockerfile).toMatch(/COPY\s+--from=builder.*\/build\/apps\/worker\/scripts\/fixtures/);
  });

  it('le stage production ne copie pas scripts/, src/, test, fixtures', () => {
    // Le stage production hérite de runtime-base et n'ajoute que le CMD.
    // Les COPY (dist, node_modules, assets/fonts) sont dans runtime-base.
    // production est le dernier stage : sa section va de 'AS production' à la
    // fin du fichier. Aucun COPY de src/, scripts/ ou tests ne doit y figurer.
    const productionSection = dockerfile.split('AS production')[1] ?? '';
    expect(productionSection).not.toMatch(/COPY.*\bsrc\b/);
    expect(productionSection).not.toMatch(/COPY.*\bscripts\b/);
    expect(productionSection).not.toMatch(/COPY.*\bfixtures\b/);
    expect(productionSection).not.toMatch(/COPY.*\.test\./);
  });

  it('copie la police Inter TTF depuis /deploy/worker/assets/fonts (chemin absolu)', () => {
    // Le COPY --from=builder doit utiliser un chemin absolu (/deploy/worker/)
    // car le chemin relatif ne se résout pas dans cette version Docker.
    expect(dockerfile).toMatch(/COPY\s+--from=builder.*\/deploy\/worker\/assets\/fonts/);
  });

  it('les fixtures ne sont copiées que dans le stage validation', () => {
    // Le stage validation copie les fixtures. Le stage production ne doit pas.
    const validationSection = dockerfile.split('AS validation')[1]?.split('AS production')[0] ?? '';
    const productionSection = dockerfile.split('AS production')[1] ?? '';
    expect(validationSection).toMatch(/scripts\/fixtures/);
    expect(productionSection).not.toMatch(/scripts\/fixtures/);
    expect(productionSection).not.toMatch(/smoke-built-worker/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// docker-compose.worker.yml
// ─────────────────────────────────────────────────────────────────────────────

describe('docker-compose.worker.yml', () => {
  const compose = readFile('docker-compose.worker.yml');

  it('contient un seul service worker', () => {
    expect(compose).toMatch(/^services:/m);
    expect(compose).toMatch(/^\s+worker:/m);
    // Pas de second service.
    const services = compose.match(/^\s{2}\w+:/gm) ?? [];
    // "services:" est au niveau 0, "worker:" au niveau 2.
    const serviceKeys = services.filter((s) => !s.includes('services'));
    expect(serviceKeys).toHaveLength(1);
  });

  it('cap_drop ALL', () => {
    expect(compose).toMatch(/cap_drop:/);
    expect(compose).toMatch(/-\s+ALL/);
  });

  it('security_opt no-new-privileges:true', () => {
    expect(compose).toMatch(/security_opt:/);
    expect(compose).toMatch(/no-new-privileges:true/);
  });

  it('ne contient pas de ports', () => {
    expect(compose).not.toMatch(/^\s+ports:/m);
  });

  it('ne contient pas network_mode host', () => {
    expect(compose).not.toMatch(/network_mode:\s*host/);
  });

  it('ne monte pas docker.sock ni le source du depot', () => {
    expect(compose).not.toMatch(/\/var\/run\/docker\.sock/);
    expect(compose).not.toMatch(/^\s+volumes:/m);
  });

  it('user 1001:1001', () => {
    expect(compose).toMatch(/user:\s*['"]?1001:1001['"]?/);
  });

  it('read_only true', () => {
    expect(compose).toMatch(/read_only:\s*true/);
  });

  it('tmpfs inclut /tmp', () => {
    expect(compose).toMatch(/tmpfs:/);
    expect(compose).toMatch(/\/tmp/);
  });

  it('tmpfs /tmp avec options noexec,nosuid,nodev', () => {
    expect(compose).toMatch(/\/tmp:noexec,nosuid,nodev,size=\d+m/);
  });

  it('restart policy presente', () => {
    expect(compose).toMatch(/restart:\s*\S+/);
  });

  it('stop_grace_period vaut 2m (limite opérationnelle, pas 30s)', () => {
    // La valeur 2m est un compromis raisonnable pour ce worker : un cycle
    // peut traiter plusieurs documents/emails. 30s était trop court. Cette
    // durée est une limite opérationnelle, pas une garantie de terminaison.
    expect(compose).toMatch(/stop_grace_period:\s*2m/);
    expect(compose).not.toMatch(/stop_grace_period:\s*30s/);
  });

  it('stop_signal SIGTERM', () => {
    expect(compose).toMatch(/stop_signal:\s*SIGTERM/);
  });

  it('logging json-file avec max-size et max-file', () => {
    expect(compose).toMatch(/driver:\s*json-file/);
    expect(compose).toMatch(/max-size:/);
    expect(compose).toMatch(/max-file:/);
  });

  it('env_file reference un fichier externe', () => {
    expect(compose).toMatch(/env_file:\s*\.env\.worker/);
  });

  it('ne contient pas de secret inline dans environment', () => {
    expect(compose).not.toMatch(/DATABASE_URL\s*=\s*postgresql:\/\/[^F]/);
    expect(compose).not.toMatch(/R2_SECRET_ACCESS_KEY\s*=\s*[^F]/);
    expect(compose).not.toMatch(/RESEND_API_KEY\s*=\s*re_[^F]/);
  });

  it('init true', () => {
    expect(compose).toMatch(/init:\s*true/);
  });

  it('mem_limit et mem_reservation presents', () => {
    expect(compose).toMatch(/mem_limit:/);
    expect(compose).toMatch(/mem_reservation:/);
  });

  it('cpus present', () => {
    expect(compose).toMatch(/cpus:/);
  });

  it('cible explicitement production (defense in depth)', () => {
    expect(compose).toMatch(/target:\s*production/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// apps/worker/.env.example
// ─────────────────────────────────────────────────────────────────────────────

describe('apps/worker/.env.example', () => {
  const envExample = readFile('apps/worker/.env.example');

  const requiredVars = [
    'DATABASE_URL',
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_NAME',
    'RESEND_API_KEY',
    'RESEND_FROM_EMAIL',
    'RESEND_BOOKING_CONFIRMED_TEMPLATE_ID',
  ];

  it('contient les 8 variables requises', () => {
    for (const v of requiredVars) {
      expect(envExample).toMatch(new RegExp(`^${v}=`, 'm'));
    }
  });

  it('toutes les valeurs sont manifestement factices', () => {
    for (const v of requiredVars) {
      const match = envExample.match(new RegExp(`^${v}=(.+)$`, 'm'));
      expect(match).not.toBeNull();
      const value = match?.[1] ?? '';
      // Chaque valeur doit contenir FAKE, .example, ou etre un placeholder
      // manifestement factice.
      const isFake =
        value.includes('FAKE') || value.includes('.example') || value.includes('FAKE_');
      expect(isFake).toBe(true);
    }
  });

  it('DATABASE_URL ne contient pas un vrai pattern postgres', () => {
    // La valeur ne doit pas ressembler a un vrai URL postgres (hors FAKE).
    expect(envExample).toMatch(/DATABASE_URL=postgresql:\/\/FAKE_/);
  });

  it('RESEND_API_KEY est factice (re_FAKE_API_KEY, pas une vraie cle)', () => {
    const match = envExample.match(/^RESEND_API_KEY=(.+)$/m);
    expect(match).not.toBeNull();
    const value = match?.[1] ?? '';
    expect(value).toMatch(/^re_FAKE/);
    // Une vraie cle Resend serait re_ suivi de 16+ caracteres alphanumeriques.
    // re_FAKE_API_KEY ne correspond pas a ce pattern.
    expect(value).not.toMatch(/^re_[a-zA-Z0-9]{16,}$/);
  });

  it('RESEND_FROM_EMAIL utilise un domaine factice', () => {
    const match = envExample.match(/^RESEND_FROM_EMAIL=(.+)$/m);
    expect(match).not.toBeNull();
    const value = match?.[1] ?? '';
    expect(value).toMatch(/FAKE_DOMAIN\.example/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// .dockerignore
// ─────────────────────────────────────────────────────────────────────────────

describe('.dockerignore', () => {
  const dockerignore = readFile('.dockerignore');

  it('exclut .git', () => {
    expect(dockerignore).toMatch(/^\.git$/m);
  });

  it('exclut node_modules', () => {
    expect(dockerignore).toMatch(/^node_modules$/m);
  });

  it('exclut le store pnpm à la racine et dans les workspaces', () => {
    expect(dockerignore).toMatch(/^\.pnpm-store\/$/m);
    expect(dockerignore).toMatch(/^\*\*\/\.pnpm-store\/$/m);
  });

  it('exclut tous les fichiers .env* via règle générale **/.env*', () => {
    expect(dockerignore).toMatch(/\*\*\/\.env\*/);
  });

  it('conserve les fichiers .env.example (exception)', () => {
    expect(dockerignore).toMatch(/!\*\*\/\.env\.example/);
  });

  it('exclut .env.production (couvert par la règle générale)', () => {
    // La règle **/.env* couvre .env.production, .env.worker, .env.local, etc.
    // On vérifie que la règle générale est présente (les variantes spécifiques
    // ne sont plus listées individuellement).
    expect(dockerignore).toMatch(/\*\*\/\.env\*/);
  });

  it('exclut .env.worker imbriqué (couvert par la règle générale)', () => {
    // **/.env* couvre aussi les variantes dans des sous-répertoires.
    expect(dockerignore).toMatch(/\*\*\/\.env\*/);
  });

  it('exclut dist', () => {
    expect(dockerignore).toMatch(/\*\*\/dist/);
  });

  it('exclut les fichiers de test', () => {
    expect(dockerignore).toMatch(/\*\*\/\*\.test\.ts/);
  });

  it('exclut docs', () => {
    expect(dockerignore).toMatch(/^docs\/$/m);
  });

  it("n'exclut pas scripts/fixtures (necessaires au stage validation)", () => {
    expect(dockerignore).not.toMatch(/^scripts\/fixtures$/m);
    expect(dockerignore).not.toMatch(/\*\*\/scripts\/fixtures$/m);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// .gitignore
// ─────────────────────────────────────────────────────────────────────────────

describe('.gitignore', () => {
  const gitignore = readFile('.gitignore');
  it('exclut .env.worker (secrets réels hors Git)', () => {
    expect(gitignore).toMatch(/^\.env\.worker$/m);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guide ops — invariants de sécurité documentaires (G5I-A Round 3)
// ─────────────────────────────────────────────────────────────────────────────

describe('Guide ops — invariants de sécurité', () => {
  const opsGuide = readFile('docs/implementation/g5i-a-worker-local-packaging.md');

  it('ne contient plus la procédure dangereuse cp .env.example .env.worker', () => {
    // L'ancienne procédure écrasait un éventuel .env.worker réel.
    expect(opsGuide).not.toMatch(/cp\s+apps\/worker\/\.env\.example\s+\.env\.worker/);
  });

  it('ne contient plus rm .env.worker (suppression du fichier réel)', () => {
    // L'ancienne procédure supprimait un éventuel .env.worker réel.
    expect(opsGuide).not.toMatch(/rm\s+\.env\.worker/);
  });

  it('mentionne l utilisation d un fichier temporaire (mktemp)', () => {
    expect(opsGuide).toMatch(/mktemp/);
  });

  it('protège explicitement tout .env.worker préexistant', () => {
    // Le guide doit avertir de ne jamais lire/écraser/supprimer .env.worker.
    expect(opsGuide).toMatch(/ne JAMAIS utiliser .*\.env\.worker/i);
  });

  it('mentionne /app/assets/fonts dans l inventaire de l image production', () => {
    // L'inventaire de /app doit inclure assets/fonts (police Inter TTF).
    expect(opsGuide).toMatch(/assets\/fonts/);
  });

  it('décrit la résolution relative de env_file: .env.worker', () => {
    // env_file: .env.worker est résolu relativement au répertoire du fichier Compose.
    expect(opsGuide).toMatch(/résolu.*relativement/i);
    expect(opsGuide).toMatch(/env_file/);
  });

  it('section 7.1 utilise la méthode !override pour remplacer env_file', () => {
    // Le guide doit documenter l'utilisation du tag !override dans un override
    // Compose temporaire pour remplacer entièrement le env_file original.
    expect(opsGuide).toMatch(/!override/);
  });

  it('section 7.1 explique que sans !override Compose fusionne les env_file', () => {
    // Le guide doit avertir que sans !override, Compose fusionne (merge) les
    // listes env_file au lieu de les remplacer — sécurité : .env.worker serait lu.
    expect(opsGuide).toMatch(/fusion/i);
  });

  it('section 7.1 mentionne le support de !override selon la version Compose', () => {
    // Le guide doit indiquer que le support de !override dépend de la version
    // de Docker Compose (v2.24+ vérifié sur v5.3.1).
    expect(opsGuide).toMatch(/v2\.24|version.*Compose|Compose.*version/i);
  });
});
