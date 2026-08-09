# G5I-A — Packaging local Docker du worker

- **Phase** : G5I-A
- **Périmètre** : préparation et test LOCAL de l'image Docker et de la config
  Compose du `@uttily/worker` pour un futur déploiement VPS.
- **Statut** : Packaging Docker implémenté, validé statiquement ET validé en
  runtime Docker (G5I-B). Build, inspection, smoke, échec de configuration,
  Compose, démarrage avec PostgreSQL éphémère et SIGTERM tous exécutés avec
  succès.
- **Déploiement** : NON EFFECTUÉ. Aucun SSH, aucun changement VPS, aucun
  fournisseur réel configuré (Neon, Cloudflare R2, Resend).
- **Docker runtime** : EXÉCUTÉ (G5I-B). Docker Engine 29.5.2, Compose 5.3.1,
  architecture aarch64. Build production (implicite) et validation, inspection
  image, smoke harness, échec de configuration, validation Compose avec
  !override, démarrage avec PostgreSQL/PostGIS éphémère et SIGTERM tous
  exécutés avec succès. Deux défauts runtime corrigés : `pnpm deploy --legacy`
  (pnpm v10) et chemins absolus pour `COPY --from=builder`.

## 1. Livrables

| Fichier | Rôle |
| --- | --- |
| `Dockerfile.worker` | Multi-stage (builder / runtime-base / validation / production). Build context = racine du monorepo. Production = stage par défaut (dernier FROM). |
| `.dockerignore` | Exclusions du build context (secrets, dist, tests, docs, node_modules). |
| `docker-compose.worker.yml` | Config Compose durcie (non-root, read-only, cap_drop, limits). |
| `apps/worker/.env.example` | Modèle d'environnement versionnable (valeurs factices). |
| `apps/worker/src/docker-packaging.test.ts` | Validation statique des fichiers Docker (sans daemon Docker). |
| `apps/worker/package.json` | Correctif : `postgres` déplacé de `devDependencies` à `dependencies`. |

## 2. Prérequis

**Pour exécution future (VPS ou local avec Docker)** : Docker et Docker
Compose installés et en cours d'exécution.

**Contexte G5I-A** : le daemon Docker (colima) n'était PAS en cours
d'exécution lors du développement de G5I-A. Les validations Docker runtime
sont documentées ci-dessous mais n'ont PAS été exécutées. Seules les
validations statiques (test `docker-packaging.test.ts`) et les checks repo
(build, tests, lint, typecheck, smoke:verify) ont tourné.

- Node.js >= 24 et pnpm 10.33.3 pour les checks du dépôt existant.

## 3. Build local (depuis la racine du monorepo)

### Image production

Production est le stage par défaut (dernier FROM dans Dockerfile.worker). Un
build sans `--target` produit l'image production :

```bash
# Forme courte (production = stage par défaut, dernier FROM) :
docker build -f Dockerfile.worker -t uttily-worker:local .
# Forme explicite (defense in depth, utilisée par Compose) :
docker build -f Dockerfile.worker -t uttily-worker:local --target production .
```

### Image validation

Le stage validation (dev-only, harness + fixtures) nécessite `--target` :

```bash
docker build -f Dockerfile.worker -t uttily-worker:validation --target validation .
```

## 4. Inspection de l'image production

```bash
# Vérifier l'utilisateur (1001), le CMD (node dist/index.js), aucun ExposedPorts.
docker image inspect uttily-worker:local

# Vérifier le contenu de /app : dist/, node_modules/ et assets/fonts/.
# Aucun scripts/, fixture, source, test ou .env ne doit être présent.
docker run --rm --entrypoint /bin/sh uttily-worker:local -c "ls -la /app"

# Vérifier l'identité : uid=1001(uttily) gid=1001(uttily).
docker run --rm --entrypoint /bin/sh uttily-worker:local -c "id"

# Vérifier l'absence de tests, fixtures, .env dans l'image production.
docker run --rm --entrypoint /bin/sh uttily-worker:local -c "find /app -name '*.test.*' -o -name 'fixture*' -o -name '.env*'"

# Vérifier l'historique des couches : aucun secret baked in.
docker image history uttily-worker:local
```

## 5. Smoke du bundle dans le conteneur (image validation)

```bash
# Lance le harness smoke par défaut (CMD du stage validation).
# Attendu : exit 0, stdout "Worker smoke: OK ...", stderr vide.
docker run --rm uttily-worker:validation

# Forme explicite.
docker run --rm uttily-worker:validation node scripts/smoke-built-worker.mjs --bundle=/app/dist/index.js
```

## 6. Configuration absente → WorkerConfigurationError

```bash
# Aucun env_file → le worker valide la config, échoue proprement.
# Attendu : exit 1, WorkerConfigurationError propre, pas de stack, pas de secret.
docker run --rm uttily-worker:local
```

## 7. Validation locale avec valeurs fictives

Les valeurs fictives de `apps/worker/.env.example` servent UNIQUEMENT à vérifier
le parsing et la validation statique de la configuration — PAS à démarrer le
worker en boucle.

### 7.1 Validation de la résolution Compose (sans démarrage)

Quand Docker sera disponible (G5I-B), la validation de la syntaxe Compose ne
doit PAS nécessiter la création d'un `.env.worker` dans le dépôt. Un vrai
`.env.worker` pourrait exister (gitignored) — ne jamais le lire, l'écraser ou
le supprimer.

Méthode sûre vérifiée sur Docker Compose v5.3.1 (utilise le tag `!override`
qui remplace la liste `env_file` entière, au lieu de la fusionner) :

```bash
# 1. Vérifier seulement l'existence d'un éventuel .env.worker, sans lire son contenu.
test -f .env.worker && echo ".env.worker existe (non lu)" || echo ".env.worker absent"

# 2. Créer un fichier temporaire hors dépôt avec les valeurs factices du modèle public.
tmpenv=$(mktemp /tmp/uttily-worker-env.XXXXXX)
trap 'rm -f "$tmpenv" "$tmpcompose"' EXIT

# 3. Créer un override Compose temporaire utilisant !override pour remplacer
#    entièrement le env_file original (.env.worker). Sans !override, Compose
#    fusionnerait les deux env_file (sécurité : .env.worker serait lu).
tmpcompose=$(mktemp /tmp/uttily-worker-compose.XXXXXX.yml)
cat > "$tmpcompose" <<EOF
services:
  worker:
    env_file: !override ["$tmpenv"]
EOF

# 4. Valider la résolution Compose avec l'override temporaire. Ne démarre AUCUN conteneur.
#    docker-compose config résout env_file en variables d'environnement dans la sortie.
docker-compose -f docker-compose.worker.yml -f "$tmpcompose" config

# 5. Le trap EXIT supprime uniquement les artefacts temporaires créés ci-dessus.
#    Ni docker-compose.worker.yml ni un éventuel .env.worker ne sont modifiés.
```

> **Note** : le tag `!override` est supporté par Docker Compose v2.24+ (vérifié
> sur v5.3.1). Si la version disponible ne supporte pas `!override`, créer dans
> un répertoire temporaire une configuration Compose complète avec `env_file`
> pointant uniquement vers le fichier temporaire, `build.context` en chemin
> absolu vers la racine du dépôt, et `dockerfile` correctement résolu. Ne pas
> utiliser `sed -i` (non portable sur macOS). G5I-B devra d'abord inspecter
> `docker-compose version` et `docker-compose config --help`, puis choisir une
> méthode supportée et fail-closed. L'invariant est : ne jamais utiliser un
> fichier `.env.worker` réel pour le test, ne jamais modifier le Compose
> versionné, et supprimer uniquement les artefacts temporaires créés par la
> validation.

### 7.2 Test contrôlé de l'échec de configuration (sans boucle de restart)

Pour vérifier que le worker gère proprement une configuration absente ou
invalide, utiliser une exécution ponctuelle SANS restart policy :

```bash
# Exécution ponctuelle : pas de -d, pas de restart, exit immédiat.
# Attendu : exit 1, WorkerConfigurationError propre, pas de stack, pas de secret.
docker run --rm uttily-worker:local
```

Ou avec un env_file factice (pour tester le parsing sans restart loop) :

> **ATTENTION** : ne JAMAIS utiliser `.env.worker` comme fichier de test. Un
> vrai `.env.worker` pourrait exister à la racine du dépôt (gitignored). Ne
> jamais le lire, l'écraser ou le supprimer. La procédure ci-dessous utilise
> exclusivement un fichier temporaire créé hors du dépôt via `mktemp`.

```bash
# Crée un fichier temporaire hors du dépôt (jamais .env.worker).
# Le modèle public .env.example ne contient aucun secret.
tmpenv=$(mktemp /tmp/uttily-worker-env.XXXXXX)
trap 'rm -f "$tmpenv"' EXIT
cp apps/worker/.env.example "$tmpenv"
# Exécution ponctuelle avec le fichier temporaire (pas de restart policy).
docker run --rm --env-file "$tmpenv" uttily-worker:local
# Attendu : exit 1, WorkerConfigurationError (creds factices invalides).
# Pas de restart loop car pas de restart policy en mode run.
# Le trap EXIT supprime uniquement le fichier temporaire créé par mktemp.
```

### 7.3 Quand utiliser `docker compose up -d`

`docker compose -f docker-compose.worker.yml up -d` ne sera utilisé qu'avec une
configuration RÉELLE et VALIDE lors d'une future validation ou d'un déploiement
autorisé. Ne JAMAIS utiliser `up -d` avec des credentials factices : la politique
`restart: unless-stopped` provoquerait une boucle de redémarrage intentionnelle,
sans valeur de test et consommant des ressources.

## 8. Arrêt gracieux

```bash
# Envoie SIGTERM, attend stop_grace_period (2m).
docker compose -f docker-compose.worker.yml stop

# Observer l'arrêt gracieux dans les logs.
docker compose -f docker-compose.worker.yml logs --tail=50

# Supprimer les conteneurs.
docker compose -f docker-compose.worker.yml down
```

### Sémantique de stop_grace_period (2m)

- SIGTERM arrête le lancement des cycles suivants ; le worker cesse de claimer
  de nouveaux événements outbox.
- Le cycle courant reçoit une période de grâce de 2 minutes pour terminer.
- Après expiration, le runtime peut forcer l'arrêt (SIGKILL) — la terminaison
  du cycle courant n'est PAS garantie si un fournisseur externe est lent ou bloqué.
- L'idempotence des effets (clés d'idempotence Resend, putIfAbsent R2), les
  leases outbox et le reclaim permettent la reprise ultérieure des effets
  interrompus : un cycle tué à mi-chemin sera retraité proprement au prochain
  démarrage.
- Cette durée (2m) est une limite opérationnelle, pas une garantie de
  terminaison. Un cycle traitant plusieurs documents/emails peut nécessiter
  plus de temps ; la valeur 2m est un compromis raisonnable pour ce worker.

## 9. Consultation des logs

```bash
docker compose -f docker-compose.worker.yml logs -f --tail=100
```

Les logs sont JSON (`ConsoleWorkerLogger`), rotatés via `json-file`
`max-size: 10m`, `max-file: 3`.

## 10. Vérification du code de sortie

```bash
# Affiche les codes de sortie.
docker compose -f docker-compose.worker.yml ps -a

# Code de sortie explicite.
docker inspect --format='{{.State.ExitCode}}' uttily-worker
```

## 11. Rollback vers une image précédente

```bash
# Tagger l'image courante avant chaque déploiement.
docker tag uttily-worker:local uttily-worker:local-$(date +%Y%m%d-%H%M%S)

# Rollback : pointer image: vers le tag précédent dans docker-compose.worker.yml,
# puis :
docker compose -f docker-compose.worker.yml up -d

# Ou avec un tag piné et --no-build :
docker compose -f docker-compose.worker.yml up -d --no-build
```

## 12. Procédure future de configuration VPS — NON EXÉCUTÉE

> Toutes les étapes ci-dessous sont marquées « NON EXÉCUTÉE dans G5I-A ».
> Elles seront exécutées lors du lot de déploiement réel, pas dans G5I-A.

1. **NON EXÉCUTÉE** — SSH vers `sokar` (VPS DigitalOcean Frankfurt).
2. **NON EXÉCUTÉE** — Vérifier Docker + Docker Compose (déjà présents selon
   G5G).
3. **NON EXÉCUTÉE** — Copier `Dockerfile.worker`, `docker-compose.worker.yml`
   et `apps/worker/.env.example` vers le VPS.
4. **NON EXÉCUTÉE** — Créer `/opt/uttily/.env.worker` avec des VRAIS credentials
   (chmod 600, propriétaire dédié `uttily`, jamais `source`). Le `env_file:
   .env.worker` dans `docker-compose.worker.yml` est résolu relativement au
   répertoire du fichier Compose. Si le Compose est stocké dans
   `/opt/uttily/docker-compose.worker.yml`, ce chemin relatif `.env.worker`
   résout `/opt/uttily/.env.worker` (chemin absolu). Si le fichier `.env.worker`
   est ailleurs, ajuster le `env_file` vers un chemin absolu dans une override
   Compose (ne pas modifier le Compose versionné).
5. **NON EXÉCUTÉE** — `docker build -f Dockerfile.worker -t uttily-worker:local .`
   (production = stage par défaut ; `--target production` optionnel pour clarté).
6. **NON EXÉCUTÉE** — `docker compose -f docker-compose.worker.yml up -d`.
7. **NON EXÉCUTÉE** — Vérifier les logs : `docker compose -f
   docker-compose.worker.yml logs -f --tail=100`.

## 13. Distinction préparation locale vs déploiement réel

G5I-A a livré le packaging local : `Dockerfile.worker`,
`docker-compose.worker.yml`, `.env.example`, ce guide ops, et un test de
validation statique. Aucun déploiement n'est effectué. Aucun fournisseur réel
n'est configuré. Aucun secret réel n'est manipulé.

- **G5I-A** : validation statique uniquement. Le daemon Docker (colima) n'a pas
  été démarré pendant G5I-A. Seules les validations statiques et les checks du
  dépôt existant (build, tests, lint, typecheck, smoke:verify) ont été exécutés.
- **G5I-B** : Colima démarré avec autorisation de l'utilisateur. Validations
  runtime Docker exécutées : build production (implicite) et validation,
  inspection image, smoke harness, échec de configuration, validation Compose
  avec `!override`, démarrage avec PostgreSQL/PostGIS éphémère et SIGTERM.
  Docker Engine 29.5.2, Compose 5.3.1, architecture aarch64.
- **Aucun déploiement distant effectué** : aucune connexion SSH, aucun
  changement VPS, aucun fournisseur réel configuré. Les étapes VPS (section 12)
  restent marquées NON EXÉCUTÉES.

Packaging Docker implémenté, validé statiquement ET validé en runtime Docker
(G5I-B) : build, inspection, smoke, échec de configuration, Compose, démarrage
avec PostgreSQL éphémère et SIGTERM tous exécutés avec succès.

Aucun effet R2 ou Resend n'a été déclenché : la base éphémère contenait une
outbox vide et tous les cycles ont rapporté `claimedCount=0`. L'absence totale
de trafic réseau n'a pas été instrumentée au niveau réseau.

Le déploiement réel (SSH vers sokar, configuration Neon/R2/Resend, création de
`.env.worker` avec vrais credentials, build et démarrage sur le VPS) est un lot
distinct futur.

## 14. Aucune commande destructrice large

Ce guide ne documente aucune commande du type `docker system prune -a`,
`rm -rf`, ou équivalent. Seules des commandes ciblées sont utilisées.
