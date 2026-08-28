# Environnements — Uttily

Trois environnements séparés : **local**, **staging** et **production**.
Aucun secret n'est versionné. Les variables sont fournies via `.env` en local
et via le fournisseur d'hébergement (Vercel / Neon) pour staging et production.

## Local

- Runtime : Node.js 24 LTS (voir `.nvmrc`).
- Package manager : pnpm (voir `package.json`).
- Workflow canonique : `pnpm dev:full` démarre le service `postgres` de Docker
  Compose avec le fichier `docker-compose.yml` racine, attend que le healthcheck
  `pg_isready` confirme que PostgreSQL est prêt, applique automatiquement les
  migrations, puis démarre Next.js et le worker local. PostgreSQL est publié
  uniquement sur `127.0.0.1:5432`, jamais sur toutes les interfaces réseau.
  - `pnpm dev:full -- --no-worker` démarre le parcours Web + PostgreSQL sans
    worker.
  - `pnpm db:seed` applique explicitement la fixture locale/dev-only
    idempotente ; `pnpm dev:full -- --seed` l'exécute après les migrations et
    avant Web/worker. La combinaison `--seed --no-worker` est également
    acceptée. Ces deux chemins fournissent `UTTILY_LOCAL_DEV=1` au script de
    seed ; toute autre valeur, ou `NODE_ENV=production`, est refusée avant la
    connexion PostgreSQL.
  - Le seed ne crée aucun utilisateur Clerk, compte/provider réel, paiement,
    réservation ou appel réseau externe. Il prépare l'offre publique de
    démonstration `lyon-dev` / `kayak-dev` (lieu `lyon-shop-dev`, SKU
    `KAY-DEV-001`) sans supprimer de ligne.
  - `Ctrl+C` arrête Web et le worker proprement ; PostgreSQL reste actif et
    n'est jamais arrêté ou supprimé automatiquement. La garantie d'arrêt complet
    des descendants est validée et supportée sur macOS/Linux (POSIX) : toutes les
    commandes orchestrées de pré-démarrage, ainsi que Web et worker, y sont
    lancées dans des groupes de processus afin d'inclure leurs descendants. Sous
    Windows, le workflow peut démarrer, mais la terminaison des descendants n'est
    pas garantie tant qu'une stratégie Job Objects n'est pas implémentée.
  - Une interruption pendant l'inspection Docker, la détection Compose, le
    démarrage Compose, le healthcheck `pg_isready` ou les migrations termine
    l'étape en cours, retourne le code 0 et ne lance pas l'étape suivante.
- Garde-fous de base : toute valeur existante de `DATABASE_URL` ou
  `DATABASE_DIRECT_URL` qui n'est pas locale est refusée sans être affichée.
  Les processus enfants reçoivent ensuite les URLs locales fixes, afin que
  `.env.local` ne puisse pas détourner ce workflow vers une base distante.
- Garde-fous Docker : le CLI Docker et l'inspection réussie du contexte
  réellement actif ainsi que de son endpoint local sont requis avant `compose
  up`, sans afficher ces valeurs. Si le CLI Docker est absent ou si l'inspection
  échoue, `dev:full` échoue fail-closed avant toute commande `docker-compose`.
  Tout moteur distant (`tcp:`, `ssh:`, `http:` ou `https:`) est refusé
  fail-closed. Une fois validé, l'endpoint local inspecté est conservé uniquement
  en mémoire et verrouillé pour chaque commande Compose : le plugin reçoit
  `docker compose ...` avec `DOCKER_HOST=<endpoint-local-inspecté>` et
  `DOCKER_CONTEXT` retiré ; le fallback standalone reçoit le même
  `DOCKER_HOST=<endpoint-local-inspecté>` et `DOCKER_CONTEXT` retiré. Le nom du
  contexte sert uniquement à sélectionner et inspecter le moteur avant
  l'exécution ; il ne pilote jamais Compose après validation. La détection essaie
  `docker compose`, puis `docker-compose` si le plugin est absent ; ce fallback
  standalone est uniquement celui du plugin et n'est permis qu'après validation
  du contexte et de son endpoint local. Un changement ultérieur de la définition
  du contexte ne peut donc pas rediriger Compose. Seuls les contextes `default`,
  `colima`, `desktop-linux` ou `docker-desktop` sont autorisés ; aucun démarrage
  ou arrêt automatique de Colima n'est effectué.
- Cloisonnement Docker : chaque commande `docker`/Compose, y compris
  l'inspection du contexte et `pg_isready`, reçoit un environnement filtré limité
  à `PATH` et aux variables Docker/Compose autorisées. Les secrets applicatifs
  (`DATABASE_URL`, clés Stripe, R2, Resend, Clerk, `CRON_SECRET`, etc.) ne sont
  jamais transmis à ces processus enfants.
- Protection Stripe locale : `dev:full` refuse toute clé Stripe non-TEST,
  accepte `undefined` et la chaîne vide comme absence, force
  `STRIPE_ENVIRONMENT=TEST` et `PAYMENTS_LIVE_ENABLED=false`, puis transmet
  explicitement une clé TEST validée ou une chaîne vide pour chaque clé Stripe
  aux processus enfants. Toute clé Stripe LIVE Web est donc désactivée, y
  compris une valeur chargée depuis `.env.local`. Pour effectuer de vrais
  appels Stripe TEST, utiliser un environnement séparé dédié ; `dev:full` ne
  doit jamais être utilisé pour des appels Stripe LIVE.
- Protection Clerk et webhooks : `pnpm dev:full` exige que
  `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` et `CLERK_SECRET_KEY` soient exportées
  avec de vraies clés Clerk TEST valides. Les clés doivent avoir exactement les
  préfixes `pk_test_` et `sk_test_`, suivis d'un suffixe suffisamment long en
  caractères base64url attendus. Les valeurs absentes, vides, trop courtes ou
  LIVE sont refusées sans être affichées avant Docker et les migrations ; aucun
  placeholder n'est utilisé. Sans ces clés TEST réelles, seules les validations
  statiques passent et le Web ne démarre pas : aucune route, publique ou
  authentifiée, n'est promise avec des placeholders. Les clés TEST validées
  sont transmises aux processus enfants. Les secrets `CLERK_WEBHOOK_SECRET`,
  `STRIPE_PLATFORM_WEBHOOK_SECRET` et `STRIPE_CONNECT_WEBHOOK_SECRET` sont
  explicitement transmis comme chaînes vides. `CRON_SECRET` est fixé à
  `dev-cron-secret-local`, sans reprendre une valeur héritée.
- Isolation de la recherche publique et des origins : `dev:full` injecte
  `PUBLIC_SEARCH_CURSOR_SECRET=uttily-local-dev-public-search-cursor-v1`, une
  valeur dev/test fixe, non sensible et interdite en staging/production. Il
  force aussi `ALLOWED_ORIGINS` à la chaîne vide dans l'environnement enfant.
  Ces variables sont toujours présentes dans l'environnement transmis, afin
  qu'aucune valeur héritée ni valeur de `apps/web/.env.local` ne puisse les
  réintroduire.
- Worker local : providers exclusivement fake en mémoire et déterministes ;
  les variables de credentials R2/Resend héritées sont neutralisées par des
  chaînes vides dans l'environnement enfant, afin que Next.js ne puisse pas les
  recharger depuis `apps/web/.env.local`. Le worker fake et le Web local ne
  reçoivent aucun credential R2/Resend effectif et ne font aucun appel à ces
  fournisseurs réels.
- `pnpm dev:full` sans `--seed` migre uniquement la base et ne crée aucune
  donnée métier. Le seed est fourni séparément via `pnpm db:seed` ou l'option
  explicite `pnpm dev:full -- --seed` ; il est local/dev-only et idempotent.
  Le script est fail-closed : `UTTILY_LOCAL_DEV` doit être exactement `1` et
  `NODE_ENV` ne doit pas être `production`, avec un refus avant toute connexion
  et des erreurs qui ne révèlent ni URL ni variable sensible. Il n'utilise ni
  Clerk ni provider réel et n'effectue aucun appel réseau externe.
- Sans CLI Docker, contexte local inspectable ou daemon Docker/Colima,
  `dev:full` échoue proprement. `lint`, `typecheck`, `test` et `build` restent
  fonctionnels sans Docker. `pnpm test` désigne la boucle rapide sans
  PostgreSQL, E2E ni reproductibilité PDF ; `pnpm check:fast` ajoute les
  garde-fous locaux et le typecheck. `pnpm test:postgres` exige PostgreSQL
  local joignable et exécute les suites Database sans parallélisme entre
  fichiers, afin d'éviter la contention entre bases de test. La validation
  exhaustive reste `pnpm test:full` et la matrice CI.
- Le fichier `.env` racine reste destiné aux commandes locales exécutées hors
  orchestration. Pour `dev:full`, les valeurs de l'environnement enfant sont
  imposées par le workflow, indépendamment de ces fichiers, notamment les URLs
  PostgreSQL locales, le curseur public dev/test et `ALLOWED_ORIGINS` neutralisé.

## Staging

- Web : Vercel (preview / staging).
- Base : Neon (branche de staging), région européenne.
- Documents : bucket Cloudflare R2 privé `uttily-staging-documents`,
  juridiction européenne ; l'endpoint régional est dérivé par l'adaptateur et
  n'est pas une variable configurable librement.
- Photos produit : bucket Cloudflare R2 privé dédié, configuré par
  `R2_PHOTOS_BUCKET_NAME` ; aucune URL R2 n'est exposée au navigateur, les
  lectures passent par les routes applicatives contrôlées.
- Emails : domaine Resend `sokar.tech` vérifié, expéditeur
  `Uttily <noreply@sokar.tech>` et template de confirmation publié.
- Worker : conteneur `uttily-worker-staging` isolé sur l'hôte staging existant,
  avec credentials R2/Resend hors dépôt et droits minimaux.
- Scheduler : Worker Cloudflare `uttily-staging-cron`, déclenché chaque minute
  sur le plan Workers Free ; il appelle séquentiellement les quatre routes
  `/api/cron/*` avec `CRON_SECRET`. Les Cron Jobs Vercel sont désactivés pour
  rester compatible avec le plan Hobby.
- Variables : configurées dans le projet Vercel et Neon.
- Aucune donnée de production.
- Le premier smoke test connecté R2/Resend/worker est consigné dans
  `docs/implementation/g8a-staging-r2-resend-worker-smoke-test.md`.
- Le smoke test authentifié Web complet et les preuves de rollback sont consignés
  dans `docs/implementation/g8a-web-staging-deployment.md`.

## Production

- Web : Vercel (production).
- Base : Neon (branche principale), région européenne.
- Variables : configurées dans le projet Vercel et Neon, accès restreint.
- Aucune modification manuelle de la base ; migrations versionnées uniquement.

## Variables d'environnement attendues

| Variable | Local | Staging / Production | Remarque |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | `production` | |
| `NEXT_PUBLIC_APP_NAME` | `Uttily` | `Uttily` | |
| `DATABASE_URL` | `postgresql://...` | fournie par Neon (endpoint **pooled**, hostname avec `-pooler`) | PostgreSQL + PostGIS. Connexion runtime distant : application Web et worker. Les tests unitaires n'utilisent aucune base. Les tests d'intégration PostgreSQL destructifs utilisent uniquement PostgreSQL local (garde-fou `assertLocalhost`). |
| `DATABASE_DIRECT_URL` | `postgresql://...` (peut être identique à `DATABASE_URL` en local) | fournie par Neon (endpoint **direct**, hostname **sans** `-pooler`) | Réservée aux migrations Drizzle Kit et opérations administratives explicites. Jamais utilisée par le runtime. |
| `PUBLIC_APP_URL` | `http://localhost:3000` | URL HTTPS publique du déploiement | Origine absolue sans chemin, query ni fragment ; utilisée pour le retour Stripe. Le serveur refuse une valeur locale ou HTTP en environnement de production. |
| `STRIPE_ENVIRONMENT` | `TEST` | `TEST` pour staging, `LIVE` uniquement après ADR-010 | Valeur explicite ; aucun défaut silencieux en production. |
| `PAYMENTS_LIVE_ENABLED` | `false` | `false` tant que les verrous ADR-010 ne sont pas fermés | Le serveur refuse `LIVE` sans `true`. |
| `PLATFORM_COMMISSION_RATE_BPS` | `1000` | valeur décidée et versionnée par environnement | Configuration serveur obligatoire ; `1000` = 10 %, et même `0` doit être explicite. Une commission LIVE nulle est refusée. |
| `CRON_SECRET` | `dev-cron-secret-local` | générée (voir ci-dessous) | Authentification des endpoints Vercel Cron (`expire-holds`, `process-compensations`, `process-refund-requests` et `process-product-analytics`) |
| `R2_PHOTOS_BUCKET_NAME` | vide en local | bucket R2 privé dédié au staging / à la production | Obligatoire pour les uploads photo ; le serveur refuse l'absence de bucket et ne réutilise `R2_BUCKET_NAME` qu'en repli explicite |

## Connexions Neon — pooled vs direct (G5G-C)

Neon fournit deux endpoints par projet :

- **Endpoint pooled** (hostname contenant `-pooler`) : utilise PgBouncer pour
  multiplexer les connexions. Adapté au runtime (application Web, worker) qui
  ouvre de nombreuses connexions courtes. **À utiliser pour `DATABASE_URL`.**
- **Endpoint direct** (hostname **sans** `-pooler`) : connexion TCP directe au
  Postgres. Requis pour Drizzle Kit (les migrations DDL ne supportent pas le
  pooling de transactions). **À utiliser pour `DATABASE_DIRECT_URL`.**

### Garde-fou `resolveMigrationUrl`

Le helper `packages/database/src/resolve-migration-url.ts` résout l'URL de
migration avec les règles suivantes :

1. **`DATABASE_DIRECT_URL` prioritaire** si définie :
   - hostname local → accepté (migration locale explicite) ;
   - hostname distant **sans** `-pooler` → accepté (endpoint direct Neon) ;
   - hostname distant **avec** `-pooler` → **rejet fail-closed** (les migrations
     ne doivent pas passer par le pooler).
2. **`DATABASE_URL` seule** (sans `DATABASE_DIRECT_URL`) :
   - hostname local (`localhost`, `127.0.0.1`, `::1`) → accepté (développement
     local historique) ;
   - hostname distant → **rejet fail-closed** (risque d'utiliser le pooler pour
     les migrations).
3. **Aucune variable** → fallback localhost explicite
   (`postgresql://uttily:uttily@127.0.0.1:5432/uttily`).

Les messages d'erreur ne contiennent **jamais** l'URL, le mot de passe ou les
credentials.

### Garde-fou `assertLocalhost`

Le helper `packages/database/src/assert-localhost.ts` interdit tout
`DROP DATABASE` / `CREATE DATABASE` sur un hôte distant. Les tests
d'intégration destructifs (`packages/core/src/integration/setup.ts`) ne peuvent
cibler que `localhost`, `127.0.0.1` ou `::1`. Ce garde-fou n'est **pas**
modifié par G5G-C et reste la protection principale contre les destructions
accidentelles de bases distantes.

### Environnement de développement actuel

- **Neon Dev** : projet `Uttily-dev` (project ID non secret
  `little-star-24391080`), région `aws-eu-central-1` (Frankfurt), PostgreSQL 16,
  plan **Free**, Neon Auth désactivé.
- **PostgreSQL local** (Docker Compose) reste la cible de tous les tests
  d'intégration destructifs.
- **Vercel / Neon / Resend payants** uniquement au lancement commercial
  (ADR-014).
- Aucune migration distante n'est exécutée implicitement par les tests.
- La base Neon Dev ne contient **pas encore** le schéma Uttily : les migrations
  seront appliquées dans une étape séparée, après configuration manuelle des
  secrets.

Les variables spécifiques (OIDC, Stripe, stockage objet, Sentry) seront
documentées au fur et à mesure de leur introduction dans les lots concernés.

## Vercel Cron — expiration des holds (ADR-009 §18-19)

L'endpoint `/api/cron/expire-holds` est déclenché par Vercel Cron chaque
minute (`* * * * *`, voir `apps/web/vercel.json`). Il authentifie la requête via le
header `Authorization: Bearer ${CRON_SECRET}` et appelle
`expireBookingDraftsBatch(db, 10)`.

### Configuration

1. **Générer le secret** :
   ```bash
   openssl rand -base64 32
   ```

2. **Vercel — variables d'environnement** :
   - Project Settings → Environment Variables.
   - Ajouter `CRON_SECRET` pour l'environnement Production (requis par
     le Cron). Preview est facultatif (tests manuels uniquement).
   - Ne jamais committer la valeur réelle.

3. **Vercel — Cron Jobs** :
   - Le fichier `apps/web/vercel.json` (Root Directory Vercel = `apps/web`)
     déclare le cron :
     ```json
     {
       "crons": [
         { "path": "/api/cron/expire-holds", "schedule": "* * * * *" }
       ]
     }
     ```
   - Vercel détecte automatiquement cette configuration au déploiement.
   - L'exécution chaque minute nécessite un plan Vercel Pro ou
     Enterprise (le plan Hobby est limité à une exécution quotidienne).
   - Les Cron Jobs ne s'exécutent que sur les déploiements Production.
     Configurer `CRON_SECRET` en Preview peut servir aux tests manuels,
     mais ce n'est pas requis par le Cron.

4. **Local** :
   - Ajouter `CRON_SECRET=dev-cron-secret-local` dans `.env.local`.
   - L'endpoint est accessible en local via
     `http://localhost:3000/api/cron/expire-holds`.

### Sécurité

- L'endpoint est fail-closed : si `CRON_SECRET` est absent, la requête
  est rejetée avec `401 Unauthorized`.
- La comparaison du secret est à temps constant (protection contre les
  timing attacks).
- Méthode `GET` uniquement (Vercel Cron utilise `GET`).
- La réponse ne contient que des compteurs (`processedCount`,
  `expiredCount`, `anomalyCount`, `batchLimit`) — aucun identifiant de
  brouillon ni détail d'anomalie.

### Observabilité

- Log structuré JSON à chaque invocation :
  `{"event":"cron.expire-holds","durationMs":N,"processedCount":N,"expiredDraftCount":N,"expiredHoldCount":N,"anomalyCount":N,"batchLimit":10}`.
- Alerte si `anomalyCount > 0` :
  `{"event":"cron.expire-holds.anomalies","durationMs":N,"anomalyCount":N,"reasons":[...]}`.
- Log d'erreur technique :
  `{"event":"cron.expire-holds.error","durationMs":N,"error":"..."}`.
- Surveiller `anomalyCount` répété > 0 (risque de starvation, voir
  étape 5).

## Vercel Cron — traitement des refunds G7M-B2-B2B

L'endpoint `/api/cron/process-refund-requests` est déclenché chaque minute par
`apps/web/vercel.json`. Il appelle `executeRefundRequestBatch` avec
`STRIPE_ENVIRONMENT` (`TEST` par défaut hors production, ou `LIVE` explicitement
validé). En production, l'absence de cette variable est une erreur de
configuration ; aucune exécution ne bascule silencieusement en TEST. La route
effectue ensuite la vérification fail-closed de
`Authorization: Bearer ${CRON_SECRET}`.

La route expose uniquement les compteurs du batch et produit des logs JSON
structurés (`cron.process-refund-requests` et
`cron.process-refund-requests.alert`). Le provider est appelé hors transaction
par le moteur Core ; aucun runtime `apps/worker` n'est introduit. Les détails
de la route et sa matrice de 20 tests Web/PostgreSQL sont documentés dans
`docs/implementation/g7m-b2b2b-refund-cron.md`.
