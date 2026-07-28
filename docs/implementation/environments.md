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
| `DATABASE_URL` | `postgresql://...` | fournie par Neon | PostgreSQL + PostGIS |

Les variables spécifiques (OIDC, Stripe, stockage objet, Sentry) seront
documentées au fur et à mesure de leur introduction dans les lots concernés.
