# ADR-004 — ORM et stratégie de migrations

- **Statut** : accepté
- **Date** : 2026-07-27

## Contexte

Uttily repose sur PostgreSQL + PostGIS comme autorité transactionnelle. Les invariants critiques de disponibilité s'appuient sur une contrainte d'exclusion PostgreSQL (`InventoryBlock`) et sur des types géographiques PostGIS. L'ORM doit donc exposer le SQL sans le masquer, et les migrations doivent rester inspectables, versionnées et personnalisables (cf. `AGENTS.md` : « migrations versionnées ; aucune modification manuelle de production »).

## Décision

Utiliser **Drizzle ORM** et **Drizzle Kit** pour l'accès aux données et les migrations dans `packages/database`.

## Raisons

- Schéma déclaré en TypeScript, proche du SQL ; aucune abstraction magique.
- **Migrations SQL générées inspectables, éditables et personnalisables** : Drizzle Kit produit des fichiers SQL versionnés que l'on peut relire, compléter et corriger avant application.
- Léger, compatible Next.js et Node.js, modèle de requêtes explicite.
- Pas de couche intermédiaire opaque qui pourrait masquer une règle de concurrence.

## Migrations SQL explicites pour les extensions et contraintes

Drizzle ne garantit **pas automatiquement** les extensions PostgreSQL ni les contraintes d'exclusion. Celles-ci seront écrites **explicitement en SQL** dans des migrations versionnées :

- `CREATE EXTENSION IF NOT EXISTS postgis;`
- `CREATE EXTENSION IF NOT EXISTS btree_gist;`
- Types géographiques PostGIS (`geometry`, `geography`) déclarés en SQL.
- Contrainte d'exclusion `EXCLUDE USING gist` sur `InventoryBlock` (Lot 3) écrite en SQL, avec `btree_gist` pour pouvoir combiner égalité (`inventory_item_id`) et chevauchement temporel (`tstzrange`) dans la même contrainte GiST.

Ces migrations seront relues et testées avant application. Aucune modification manuelle de production.

## Conséquences

- Aucune logique métier dans `packages/database` : seuls schéma, migrations et accès brut.
- Les transactions explicites restent la responsabilité de `packages/core`.
- Prisma n'est pas retenu : son abstraction rend les migrations SQL personnalisées et les contraintes d'exclusion moins directes.
- Les migrations sont générées par `drizzle-kit generate`, puis **complétées à la main** pour les extensions et contraintes spécifiques à PostgreSQL/PostGIS, puis relues avant application.

## Non retenu

- Prisma : abstraction trop élevée pour les migrations SQL personnalisées et les contraintes d'exclusion.
- Knex ou `pg` pur : viables mais moins expressifs pour la déclaration de schéma et la sécurité de typage.
