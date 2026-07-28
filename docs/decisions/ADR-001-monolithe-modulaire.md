# ADR-001 — Monolithe modulaire au lancement

- **Statut** : accepté
- **Date** : 2026-07-27

## Contexte

Uttily réunit marketplace, SaaS loueur, disponibilité concurrente et paiement. Le produit doit évoluer vite sans compromettre les règles de réservation.

## Décision

Le premier produit est un monolithe modulaire TypeScript : Next.js pour l'interface et les endpoints, un worker séparé pour les tâches asynchrones, et un noyau métier indépendant des frameworks.

## Conséquences

- Développement et déploiement plus simples.
- Une seule base transactionnelle et des transactions cohérentes.
- Frontières métier imposées dès le début.
- Extraction ultérieure possible de l'API ou de modules à forte charge.
- Aucun microservice, Kubernetes ou Kafka dans le MVP.
