# Uttily — Instructions pour les agents de développement

## Mission produit

Uttily est une plateforme B2B2C de location d'équipements. Le premier marché cible est constitué de **loueurs professionnels**. Le MVP doit permettre une réservation réelle d'un équipement physiquement disponible dans une destination précise.

Avant toute tâche, lire dans cet ordre :

1. [`README.md`](README.md)
2. [`docs/product/mvp-scope.md`](docs/product/mvp-scope.md)
3. [`docs/architecture/overview.md`](docs/architecture/overview.md)
4. [`docs/architecture/booking-and-availability.md`](docs/architecture/booking-and-availability.md)
5. [`docs/architecture/data-model.md`](docs/architecture/data-model.md)
6. [`docs/implementation/agent-context.md`](docs/implementation/agent-context.md)
7. Le lot concerné dans [`docs/implementation/backlog.md`](docs/implementation/backlog.md)

## Choix verrouillés

- Monolithe modulaire TypeScript au départ.
- Next.js full-stack ; pas d'API NestJS avant qu'un besoin explicite ne le justifie.
- PostgreSQL + PostGIS est l'autorité transactionnelle.
- Les loueurs sont des organisations ; Uttily est la source de vérité des rôles et permissions.
- Loueurs professionnels uniquement dans le MVP.
- Un panier ne contient les produits que d'un seul loueur.
- Chaque réservation porte sur des exemplaires physiques alloués immédiatement.
- Un hold temporaire précède le paiement.
- Les réservations, holds et maintenances ne peuvent pas se chevaucher pour le même exemplaire.
- Webhooks, paiements et mutations critiques sont idempotents.
- Les traitements secondaires passent par l'outbox et un worker.

## Interdictions sans ADR approuvée

- Ne pas introduire de microservices, Kafka, Kubernetes ou OpenSearch.
- Ne pas utiliser Redis comme source de vérité de disponibilité.
- Ne pas ajouter de panier multi-loueurs.
- Ne pas ajouter de location entre particuliers.
- Ne pas stocker de données de carte bancaire.
- Ne pas modifier l'état financier ou un snapshot de prix après confirmation.
- Ne pas contourner les règles de concurrence par une logique uniquement côté interface.

## Qualité attendue

- Toute mutation sensible est transactionnelle, autorisée côté serveur et idempotente.
- Toute règle métier a des tests unitaires ; toute règle de concurrence critique a des tests d'intégration PostgreSQL.
- Les montants sont des entiers en unités mineures avec devise explicite.
- Les dates sont stockées en UTC ; le fuseau du lieu est préservé séparément.
- Les composants et formulaires sont accessibles et mobile-first.
- Les migrations sont versionnées ; aucune modification manuelle de production.
- Toute décision structurelle nouvelle est ajoutée dans `docs/decisions/` avant l'implémentation.

## Processus de travail

1. Identifier le lot et ses critères d'acceptation.
2. Vérifier si une décision d'architecture est nécessaire.
3. Implémenter le plus petit changement cohérent.
4. Ajouter ou adapter les tests concernés.
5. Mettre à jour la documentation si le comportement, le schéma ou l'API évolue.

## En cas d'ambiguïté

Ne pas inventer une règle métier. Ajouter la question dans `docs/implementation/open-questions.md` ou demander une décision au porteur de produit.
