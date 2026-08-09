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

## Extension — ADR-014

Le présent ADR reste la décision d'hébergement Web + DB (Vercel + Neon). L'
[ADR-014](ADR-014-production-providers-and-worker-deployment.md) ajoute, sans
remplacer ADR-005 :

- le déploiement du worker sur un VPS DigitalOcean Frankfurt (conteneur Docker Node 24) ;
- le fournisseur de stockage objet (Cloudflare R2, juridiction `eu`) ;
- le fournisseur d'email transactionnel (Resend) ;
- la stratégie de secrets du worker et la topologie complète Web/DB/worker.

ADR-005 n'est pas marquée comme remplacée.

## Extension — G5G-C : connexions Neon pooled vs direct

Neon fournit deux endpoints par projet :

- **Endpoint pooled** (hostname avec `-pooler`) : `DATABASE_URL`, utilisé par
  l'application Web et le worker en runtime distant.
- **Endpoint direct** (hostname sans `-pooler`) : `DATABASE_DIRECT_URL`,
  réservé aux migrations Drizzle Kit et opérations administratives.
- Les tests unitaires n'utilisent aucune base. Les tests d'intégration
  PostgreSQL destructifs utilisent uniquement PostgreSQL local (garde-fou
  `assertLocalhost` rejette toute URL distante dans `DATABASE_URL`).

Le helper `resolveMigrationUrl` (`packages/database/src/resolve-migration-url.ts`)
applique un garde-fou fail-closed : une `DATABASE_URL` distante sans
`DATABASE_DIRECT_URL` est rejetée, et une `DATABASE_DIRECT_URL` contenant
`-pooler` est rejetée. Voir `docs/implementation/environments.md` pour le
détail.

## Non retenu

- Supabase : aurait introduit auth et storage intégrés non requis par l'architecture (OIDC externe + S3 compatible).
- Render / Fly.io : viables mais moins intégrés à Next.js que Vercel pour le démarrage.
