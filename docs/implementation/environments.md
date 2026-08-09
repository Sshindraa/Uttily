# Environnements — Uttily

Trois environnements séparés : **local**, **staging** et **production**.
Aucun secret n'est versionné. Les variables sont fournies via `.env` en local
et via le fournisseur d'hébergement (Vercel / Neon) pour staging et production.

## Local

- Runtime : Node.js 24 LTS (voir `.nvmrc`).
- Package manager : pnpm (voir `package.json`).
- Base de données : PostgreSQL 16 + PostGIS via Docker Compose (optionnel).
  - `docker compose up -d` démarre une base sur `localhost:5432`.
  - Sans Docker, lint, typecheck, test et build restent fonctionnels.
- Variables : copier `.env.example` en `.env` et remplir si nécessaire.
  - La validation Zod des variables sera introduite lorsqu'elles seront
    réellement consommées (à partir du Lot 1).

## Staging

- Web : Vercel (preview / staging).
- Base : Neon (branche de staging), région européenne.
- Variables : configurées dans le projet Vercel et Neon.
- Aucune donnée de production.

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
| `CRON_SECRET` | `dev-cron-secret-local` | générée (voir ci-dessous) | Authentification du Cron d'expiration des holds (ADR-009 §18-19) |

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
   (`postgresql://uttily:uttily@localhost:5432/uttily`).

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
