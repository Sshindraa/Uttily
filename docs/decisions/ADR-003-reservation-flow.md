# ADR-003 — Allocation immédiate et hold temporaire

- **Statut** : accepté
- **Date** : 2026-07-27

## Décision

Au démarrage d'un paiement, Uttily attribue les exemplaires physiques et crée un hold temporaire. Un paiement confirmé convertit ce hold en réservation.

## Raisons

- Évite la double réservation du dernier exemplaire.
- Simplifie la concurrence grâce aux contraintes PostgreSQL.
- Assure une traçabilité complète de chaque exemplaire.
- Permet de gérer la maintenance, les dommages et les transferts entre établissements.

## Garanties

- Hold expirant et libéré automatiquement.
- Clé d'idempotence sur la création de hold et de paiement.
- Webhook de paiement traité de manière idempotente.
- Transaction PostgreSQL lors de la conversion hold → réservation.

## Non retenu pour le MVP

La réservation de capacité agrégée (par exemple trois combinaisons sans exemplaire attribué) est reportée. Elle nécessiterait des verrous et règles de capacité spécifiques.
