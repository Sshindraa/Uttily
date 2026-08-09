# Uttily

Uttily est une plateforme de location d'équipements destinée d'abord aux loueurs professionnels : catalogue, stock physique, disponibilité, réservation, paiement et opérations de retrait/retour.

Ce dépôt démarre volontairement par la documentation d'architecture. Aucun choix d'implémentation ne doit contourner les décisions documentées dans [`docs/`](docs/README.md).

## Point de départ

Avant de créer l'application, lire dans cet ordre :

1. [Périmètre MVP](docs/product/mvp-scope.md)
2. [Business plan et stratégie](docs/product/business-plan.md)
3. [Vision long terme](docs/product/long-term-vision.md)
4. [Contexte pour agents de développement](docs/implementation/agent-context.md)
5. [Backlog de démarrage](docs/implementation/backlog.md)
6. [Vue d'ensemble technique](docs/architecture/overview.md)
7. [Réservations et disponibilité](docs/architecture/booking-and-availability.md)
8. [Modèle de données](docs/architecture/data-model.md)
9. [Décisions d'architecture](docs/decisions/)

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
pnpm test             # exécuter les tests
pnpm build            # builder tous les packages et apps
pnpm dev              # démarrer apps/web en développement
```

## Base de données locale (optionnelle)

```bash
docker compose up -d  # PostgreSQL 16 + PostGIS sur localhost:5432
docker compose down   # arrêter
```

Sans Docker, `lint`, `typecheck`, `test` et `build` restent fonctionnels.

## Environnements

Voir [`docs/implementation/environments.md`](docs/implementation/environments.md).
