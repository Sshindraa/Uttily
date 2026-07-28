# ADR-005 — Hébergement MVP : Vercel + Neon

- **Statut** : accepté
- **Date** : 2026-07-27

## Contexte

Le MVP est un monolithe Next.js full-stack (ADR-001) avec PostgreSQL + PostGIS comme autorité transactionnelle. L'hébergement doit rester simple, opérationnel dès le démarrage et compatible avec les environnements dev, staging et production séparés (cf. `overview.md`).

## Décision

Héberger l'application web sur **Vercel** et la base PostgreSQL sur **Neon**, dans une même région européenne.

## Raisons

- Vercel est l'hébergement natif de Next.js : App Router, Server Components, Route Handlers et Edge/Node runtimes supportés sans configuration.
- Neon fournit un PostgreSQL managé avec PostGIS, branching pour les environnements et la preview, et une faible latence vers Vercel dans une même région.
- Région européenne unique pour conformité et latence homogène entre web et base.
- Modèle à consommation adapté au démarrage, évolutif.

## Conséquences

- Le worker `apps/worker` sera déployé séparément (Lot 4+) ; son hébergement sera décidé lors de ce lot.
- Aucun Redis, Kafka, Kubernetes ou microservice dans le MVP (conforme à ADR-001 et `AGENTS.md`).
- Les secrets sont fournis via les variables d'environnement Vercel et Neon ; aucun secret n'est versionné.
- La base locale de développement reste PostgreSQL + PostGIS via Docker Compose (optionnel).

## Non retenu

- Supabase : aurait introduit auth et storage intégrés non requis par l'architecture (OIDC externe + S3 compatible).
- Render / Fly.io : viables mais moins intégrés à Next.js que Vercel pour le démarrage.
