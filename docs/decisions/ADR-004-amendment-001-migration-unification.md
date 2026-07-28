# ADR-004 Amendement 001 — Unification du mécanisme de migration

- **Statut** : accepté
- **Date** : 2026-07-28
- **Amende** : ADR-004 — ORM et stratégie de migrations

## Contexte

L'ADR-004 a verrouillé Drizzle ORM + Drizzle Kit comme ORM et outil de migration. Cependant, un runner maison (`runMigrations` dans `packages/database/src/migrate.ts`) coexistait avec le mécanisme Drizzle Kit, utilisant une table de suivi séparée `__migrations` (colonnes `id`, `filename`, `applied_at`). Ce double suivi créait un risque de divergence des historiques : une migration pouvait être enregistrée dans `__migrations` sans l'être dans `__drizzle_migrations`, ou inversement si `drizzle-kit migrate` était utilisé en parallèle.

Les tests d'intégration (PostgreSQL) utilisaient ce runner maison pour appliquer les migrations sur une base vierge, ce qui ne validait pas le chemin Drizzle Kit officiel.

## Décision

Drizzle Kit et son historique `__drizzle_migrations` deviennent l'unique mécanisme de migration pour les environnements locaux, CI, staging et production.

- La table `__migrations` maison est retirée. Le runner `runMigrations` est réimplémenté sur le migrateur programmatique `drizzle-orm/postgres-js/migrator`, qui utilise `__drizzle_migrations` et le journal `_journal.json`.
- La signature publique `runMigrations(databaseUrl: string): Promise<void>` est préservée pour ne pas casser les consommateurs (`setup.ts`, `catalog.test.ts`, `migrate.test.ts`).
- `drizzle-kit migrate` (CLI) reste l'outil de migration manuelle locale.
- Les tests d'intégration créent une base vierge puis appliquent les migrations via le migrateur Drizzle, validant ainsi le même chemin que la production.

## Raisons

- Autorité unique : un seul historique de migration évite les divergences et les doubles applications.
- Cohérence : les tests valident le même mécanisme que la production.
- Drizzle Kit gère déjà les snapshots, les hashes et le journal ; recréer un suivi parallèle n'apportait aucune valeur.
- Le migrateur programmatique `drizzle-orm/postgres-js/migrator` est maintenu par l'équipe Drizzle et compatible avec le driver `postgres-js` déjà utilisé.

## Conséquences

- Aucune base existante ne doit être migrée automatiquement sans inventaire. Les bases locales jetables peuvent être recréées. Les bases de staging/production nécessitent un inventaire explicite de l'historique `__migrations` avant toute opération.
- Les bases ayant déjà `__migrations` (locales ou de dev) peuvent être recréées from scratch (données non persistantes) ou, si l'historique doit être préservé, faire l'objet d'une migration manuelle documentée : vérifier que les 17 migrations sont présentes dans `__drizzle_migrations`, puis supprimer `__migrations`.
- Le test de migration (`migrate.test.ts`) vérifie désormais la table `__drizzle_migrations`, les extensions (postgis, btree_gist), la contrainte `no_overlapping_blocks`, l'absence de table `__migrations` créée par le code, et l'idempotence du rejeu.

## Procédure de transition pour bases existantes

### Bases locales (procédure unique)

Aucune base staging ou production n'existe à ce stade du projet. Toutes les bases locales sont jetables. La procédure unique pour toute base locale existante est la **recréation from scratch** :

```bash
docker compose down -v && docker compose up -d postgres
# Puis appliquer les migrations via runMigrations ou drizzle-kit migrate.
```

Aucun script de réconciliation n'est fourni ni nécessaire.

### Future base non jetable

Si une base non jetable (staging, production) devait exister à l'avenir avec un historique `__migrations` legacy et aucun historique Drizzle, la procédure serait :
1. **Arrêt** : ne rien exécuter automatiquement.
2. **Inventaire** : documenter l'état exact du schéma et de l'historique `__migrations`.
3. **Runbook ponctuel** : rédiger un runbook spécifique à cette base, revu avant exécution, créant le schéma `drizzle`, la table `__drizzle_migrations`, et insérant les couples exacts `{ hash, created_at }` dans une transaction unique.
4. **Validation** : confirmer que `runMigrations` est un no-op après réconciliation.

Cette procédure n'est pas anticipée : elle sera rédigée uniquement si le besoin se matérialise, avec un ADR dédié.

## Non retenu

- Conserver les deux mécanismes en parallèle : risque de divergence, complexité de maintenance.
- Migrer automatiquement les bases existantes de `__migrations` vers `__drizzle_migrations` sans inventaire : trop risqué pour les bases de staging/production.
