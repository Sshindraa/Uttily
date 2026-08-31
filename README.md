# Uttily

Uttily est une plateforme de location d'équipements destinée d'abord aux loueurs professionnels : catalogue, stock physique, disponibilité, réservation, paiement et opérations de retrait/retour.

Ce dépôt démarre volontairement par la documentation d'architecture. Aucun choix d'implémentation ne doit contourner les décisions documentées dans [`docs/`](docs/README.md).

## Point de départ

Avant toute tâche, lire `AGENTS.md`, puis dans cet ordre :

1. [Périmètre MVP](docs/product/mvp-scope.md)
2. [Vue d'ensemble technique](docs/architecture/overview.md)
3. [Réservations et disponibilité](docs/architecture/booking-and-availability.md)
4. [Modèle de données](docs/architecture/data-model.md)
5. [Contexte pour agents de développement](docs/implementation/agent-context.md)
6. [Backlog de démarrage](docs/implementation/backlog.md)
7. Le lot et les [décisions d'architecture](docs/decisions/)

Pour les frais marketplace, consulter ensuite l'[état canonique du modèle
13/7](docs/operations/marketplace-fees-current-state.md) puis
[ADR-029](docs/decisions/ADR-029-marketplace-fee-split-13-7.md).

## Principes non négociables

- Loueurs professionnels uniquement au lancement.
- PostgreSQL est l'autorité finale pour le stock et les réservations.
- Un panier ne concerne qu'un seul loueur dans le MVP.
- Les opérations sensibles sont idempotentes.
- Les prix, devises, conditions et stratégies de garantie sont figés dans la réservation.
- Les traitements secondaires passent par une outbox et un worker.
- La vision long terme est l'option C : OS loueur + marketplace + intelligence +
  distribution partenaires/agents, sans élargir prématurément le MVP (ADR-019).

## Stack

- Node.js 24 LTS, TypeScript strict, pnpm workspaces.
- Next.js (App Router) pour `apps/web` ; worker séparé dans `apps/worker`.
- Packages : `core`, `database`, `contracts`, `auth`, `ui`, `config`.
- PostgreSQL + PostGIS ; Drizzle ORM + Drizzle Kit (ADR-004).
- Hébergement : Vercel + Neon, région européenne (ADR-005).
- Tests : Vitest. Lint : ESLint flat config. Formatage : Prettier. CI : GitHub Actions.

## Commandes

```bash
pnpm install          # installer les dépendances
pnpm lint             # lint
pnpm format:check     # vérifier le formatage
pnpm format           # formater
pnpm typecheck        # vérifier les types sur tout le workspace
pnpm test             # boucle rapide de développement, sans PostgreSQL ni tests lourds
pnpm check:fast       # garde-fous locaux + tests rapides + types
pnpm test:full        # toutes les suites Vitest des workspaces ; validation finale
pnpm build            # builder tous les packages et apps
pnpm dev              # démarrer Web seul (base déjà migrée requise)
pnpm dev:full         # démarrer PostgreSQL, migrer, puis Web + worker fake
pnpm db:seed          # appliquer la fixture locale/dev-only idempotente (brouillon)
pnpm db:seed:preview  # publier une fixture synthétique locale pour tester la recherche
pnpm db:seed:browser  # fixture publique synthétique réservée à la CI E2E
pnpm benchmark:destination # mesurer le registre local ; ajouter --network pour Photon/IGN
pnpm test:dev-local   # tester les garde-fous du workflow local
pnpm recovery:restore-drill # drill restore local TEST éphémère, jamais une base distante
pnpm test:recovery     # tests ciblés du drill et des artefacts 20-B
pnpm test:scripts      # tester le garde-fou des scripts déclarés
pnpm check:scripts     # vérifier les chemins utilisés par les scripts workspace
```

`pnpm dev` démarre uniquement Next.js et n'applique aucune migration PostgreSQL.
Pour les parcours authentifiés et les écrans qui lisent la base, utiliser
`pnpm dev:full` afin de démarrer PostgreSQL et d'appliquer automatiquement toutes
les migrations avant le Web.

Le restore drill exige explicitement `UTTILY_RECOVERY_DRILL=1`, refuse
`NODE_ENV=production` et n'accepte qu'une URL PostgreSQL locale. Il crée puis
supprime uniquement ses bases éphémères générées ; il ne restaure jamais une
base d'environnement partagé ou réelle.

La boucle normale de développement est `pnpm test` ou `pnpm check:fast`.
Elle exclut explicitement les intégrations PostgreSQL, les parcours E2E et les
tests de reproductibilité PDF. Les suites Vitest complètes sont disponibles
localement avec `pnpm test:full`, mais les parcours spécialisés restent séparés
(`pnpm --filter @uttily/web test:browser`, `pnpm test:recovery` et
`pnpm --filter @uttily/worker smoke:verify`). Ces contrôles restent obligatoires
dans la matrice CI ou la validation finale selon leur prérequis. Une modification
ciblée peut aussi être validée directement avec le script `test:fast` du package
concerné.

## Workflow local SaaS complet

La commande explicite `pnpm dev:full` démarre le service `postgres` existant de
Docker Compose, attend que le healthcheck `pg_isready` confirme que PostgreSQL
est prêt, applique les migrations locales, puis lance Next.js et le worker local.
Le worker utilise uniquement `FakeDeterministicDocumentRenderer`,
`InMemoryObjectStorage` et `FakeTransactionalEmailSender` : aucun appel R2 ou
Resend réel n'est effectué.

```bash
pnpm dev:full
pnpm dev:full -- --no-worker          # parcours Web + PostgreSQL uniquement
pnpm db:seed                           # seed local/dev-only, sans démarrer Web/worker
pnpm dev:full -- --seed                # migrer, seed local, puis Web + worker fake
pnpm dev:full -- --seed --no-worker    # migrer, seed local, puis Web uniquement
```

Le workflow refuse fail-closed les URLs de base existantes qui ne pointent pas
vers `localhost`, `127.0.0.1` ou `::1`, puis impose les URLs PostgreSQL locales
aux processus enfants. Le CLI Docker et l'inspection réussie du contexte Docker
local actif et de son endpoint sont requis avant toute commande Compose, sans
afficher ces valeurs. Si le CLI Docker est absent ou si cette inspection échoue,
le workflow échoue fail-closed avant toute commande `docker-compose`. Une fois
validé, l'endpoint local inspecté est verrouillé pour toute la séquence : le
plugin reçoit `docker compose` avec `DOCKER_HOST=<endpoint-local-inspecté>` et
`DOCKER_CONTEXT` retiré, tandis que le fallback `docker-compose` reçoit le même
`DOCKER_HOST=<endpoint-local-inspecté>` et `DOCKER_CONTEXT` retiré. Le nom du
contexte sert uniquement à sélectionner et inspecter le moteur avant l'exécution
et ne pilote jamais Compose après validation. Tout moteur distant est refusé
fail-closed. La détection essaie d'abord `docker compose`, puis le binaire
`docker-compose` si le plugin est absent, uniquement après validation du contexte
et de son endpoint local. Les contextes autres que `default`, `colima`,
`desktop-linux` ou `docker-desktop` sont également refusés.
Chaque commande Docker/Compose, y compris l'inspection du contexte et
`pg_isready`, reçoit uniquement `PATH` et les variables Docker/Compose autorisées ;
les secrets applicatifs ne sont jamais transmis à ces processus enfants.
`Ctrl+C` arrête proprement Web et le
worker, mais laisse PostgreSQL actif. Une interruption pendant l'inspection
Docker, la détection Compose, le démarrage Compose, le healthcheck ou les
migrations termine l'étape en cours, sort avec le code 0 et ne lance pas
l'étape suivante. La garantie d'arrêt complet des descendants est validée et
supportée sur macOS/Linux (POSIX) : les commandes orchestrées et Web/worker y
utilisent des groupes de processus pour éviter de laisser des descendants actifs
ou orphelins lors de l'arrêt. Sous Windows, le workflow peut démarrer, mais la
terminaison des descendants n'est pas garantie tant qu'une stratégie Job Objects
n'est pas implémentée.
Les migrations sont automatiques, mais `pnpm dev:full` sans `--seed` ne crée
aucune donnée métier : après migration, la base reste inchangée. La fixture
`pnpm db:seed` (ou `pnpm dev:full -- --seed`) est strictement locale/dev-only.
Le seed est fail-closed : il refuse toute exécution si `UTTILY_LOCAL_DEV` n'est
pas exactement `1` ou si `NODE_ENV` vaut `production`. `pnpm db:seed` fournit
explicitement ce marqueur, et `dev:full -- --seed` l'injecte dans son
environnement enfant ; aucun de ces chemins ne révèle l'URL de base ou un secret.
La fixture reste idempotente et sans utilisateur Clerk, provider réel, Stripe,
réservation ou paiement. Elle prépare les données de démonstration `lyon-dev`,
`annecy-dev`, `test-org-dev`, `lyon-shop-dev`, `annecy-shop-dev`, `kayak-dev` et
leurs exemplaires en brouillon. La publication publique reste volontairement
bloquée jusqu'à l'upload de trois photos réelles via l'interface, car le
stockage R2 est neutralisé en local. Elle n'appelle aucun service externe et ne
supprime aucune ligne.

Pour tester uniquement le rendu d'une offre publique en local, utiliser
`pnpm db:seed:preview`. Cette commande exige les marqueurs local/dev et ajoute
trois métadonnées photo synthétiques avant de publier `kayak-dev`. Elle ne crée
aucun objet R2 réel et ne doit jamais être utilisée avec une base staging ou
production ; le seed normal remet ensuite le produit en brouillon.

La CI des parcours navigateur utilise séparément `pnpm db:seed:browser`. Cette
commande exige les marqueurs CI et E2E dédiés, réutilise la base éphémère du job,
ajoute uniquement les métadonnées photo synthétiques nécessaires au parcours
public, puis publie l'offre de test. Elle ne modifie pas le comportement du seed
local et ne doit pas être utilisée pour préparer des données réelles.

Pour protéger strictement le Web local contre une configuration héritée, `dev:full`
refuse toute clé Stripe non-TEST, accepte une chaîne vide comme absence, impose
`STRIPE_ENVIRONMENT=TEST` et `PAYMENTS_LIVE_ENABLED=false`, et transmet
explicitement des clés TEST ou des chaînes vides aux processus enfants. Toute
clé Stripe LIVE Web est ainsi désactivée, y compris celle qui pourrait être
présente dans `.env.local`. `pnpm dev:full` exige que
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` et `CLERK_SECRET_KEY` soient exportées avec
de vraies clés Clerk TEST valides (`pk_test_...` et `sk_test_...`). Les valeurs
absentes, vides, trop courtes ou LIVE sont refusées avant Docker et les
migrations, sans afficher les clés ; il n'existe aucun fallback placeholder.
Sans ces clés TEST réelles, seules les validations statiques du dépôt passent
et le Web ne démarre pas : aucune route, publique ou authentifiée, n'est
promise avec des placeholders. Les clés Clerk TEST validées sont transmises
aux processus Web et worker. Les secrets de webhook Clerk/Stripe hérités sont
neutralisés par des chaînes vides et `CRON_SECRET` est fixé à
`dev-cron-secret-local`. Les variables de credentials R2 et Resend héritées
sont également neutralisées par une chaîne vide dans l'environnement enfant ;
cela empêche Next.js de les recharger depuis `apps/web/.env.local`. Le worker
fake et le Web local ne reçoivent aucun credential R2/Resend effectif.
`dev:full` injecte aussi `PUBLIC_SEARCH_CURSOR_SECRET` avec la valeur fixe
`uttily-local-dev-public-search-cursor-v1`, une valeur dev/test uniquement et non
sensible, qui ne doit jamais être réutilisée en staging ou production. Il force
`ALLOWED_ORIGINS` à une chaîne vide dans l'environnement enfant : aucune valeur
héritée ni valeur de `apps/web/.env.local` ne peut ainsi réintroduire des origins
de production. Le fichier `.env` racine reste destiné aux commandes locales
exécutées hors de cette orchestration ; `dev:full` impose ses propres valeurs
locales. Pour effectuer de vrais appels Stripe TEST ou utiliser des flows Clerk
authentifiés, utilisez un environnement séparé dédié ; `dev:full` ne doit jamais
être utilisé pour des appels Stripe LIVE.

## Base de données locale (commande manuelle, optionnelle)

```bash
docker compose up -d  # PostgreSQL 16 + PostGIS sur 127.0.0.1:5432
docker compose down   # arrêter manuellement le service
```

Sans Docker CLI, contexte local inspectable ou daemon Docker, `lint`,
`typecheck`, `test` et `build` restent fonctionnels. Le workflow `dev:full`
échoue proprement si l'inspection Docker ou Docker Compose est indisponible.

## Environnements

Voir [`docs/implementation/environments.md`](docs/implementation/environments.md).
