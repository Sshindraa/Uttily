# ADR-007 — Catégories globales en UUID

- **Statut** : accepté
- **Date** : 2026-07-27

## Contexte

Le Lot 2A introduit les catégories de catalogue comme taxonomie globale gérée par l'admin Uttily (décision produit : catégories globales, pas par organisation). L'architecture impose des identifiants UUID v4 générés par PostgreSQL via `gen_random_uuid()` (cf. `docs/architecture/data-model.md`).

La première implémentation du Lot 2A utilisait `Category.id` en `text` avec des IDs déterministes (`gen-surf`, `gen-paddle`, etc.) pour faciliter le seed idempotent. Cela créait une exception non documentée à la convention UUID.

## Décision

**`Category.id` est en `uuid` avec `gen_random_uuid()` dès la migration `0010`** (création de la table). Le seed de catégories initiales (`0016`) est idempotent par `slug` (`ON CONFLICT (slug) DO NOTHING`), pas par ID. Les produits référencent `category_id` en `uuid` dès `0011`.

Le lot n'ayant jamais été déployé, le choix UUID a été intégré directement dans les migrations sources (`0010`, `0011`, `0016`) plutôt que via une migration corrective.

## Raisons

- Conformité avec la convention architecture (UUID v4 partout).
- Évite une exception non documentée qui pourrait se propager à d'autres tables de référence.
- L'idempotence par `slug` est suffisante pour le seed (les slugs sont uniques globalement).

## Conséquences

- Le seed ne peut pas être référencé par ID déterministe dans les tests ; on résout l'UUID par slug.
- `CreateCategoryInput.id` est supprimé (l'UUID est auto-généré par PostgreSQL).
