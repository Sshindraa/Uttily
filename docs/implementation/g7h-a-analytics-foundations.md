# G7H-A — Fondations analytics produit first-party

## Résultat

G7H-A introduit un ledger analytics first-party et privacy-first pour quatre
mesures produit. Les événements bruts sont stockés dans PostgreSQL avec une
rétention bornée de 90 jours ; des agrégats quotidiens ne contenant que des
compteurs sans identifiant source, soumis à validation privacy, sont calculés
avec une rétention de 24 mois.

### Mesures

| Événement source | Mesures incrémentées |
| --- | --- |
| `PUBLIC_SEARCH_PERFORMED` | `searches` (+1), `searchesWithResults` (+1 si `hasResults`) |
| `BOOKING_ATTEMPTED` | `bookingAttempts` (+1) |
| `BOOKING_CONFIRMED` | `bookingsConfirmed` (+1) |

### Schéma

- **`product_analytics_events`** : raw ledger append-only. UUID PK, `event_type`
  (enum), `environment` (`PRODUCTION`/`TEST`/`DEVELOPMENT`), `source_id` (UUID),
  `occurred_at` (timestamptz UTC), `has_results` (bool nullable). Trigger
  PostgreSQL `guard_product_analytics_event_deletion` bloque le DELETE d'un
  événement de moins de 90 jours selon `now()`.
- **`product_analytics_daily`** : agrégats quotidiens ne contenant que des
  compteurs sans identifiant source, soumis à validation privacy. Clé métier
  `(day, environment)`, quatre compteurs totaux entiers non négatifs, quatre
  compteurs compactés (défaut 0, accumulent les contributions des événements
  supprimés), `updated_at`. Contraintes CHECK : compacted >= 0, compacted <=
  total, compacted_searches_with_results <= compacted_searches.

### Modèle de compaction

Les compteurs totaux (`searches`, etc.) représentent le total historique.
Les compteurs compactés (`compacted_searches`, etc.) accumulent les
contributions des événements raw supprimés par la purge. L'invariant est :
`total = compacted + raw_still_present`.

- L'**agrégation** lit les compactés existants, compte les raw restants,
  calcule `total = compacted + raw`, UPSERT les totaux sans modifier les
  compactés. Un advisory lock `pg_advisory_xact_lock` par `(day, environment)`
  sérialise les opérations concurrentes.
- La **purge** lit les compactés existants, compte tous les raw (avant
  suppression), compte les candidats verrouillés par type, calcule
  `new_compacted = old_compacted + candidats` et `total = old_compacted +
  all_raw`, UPSERT les deux, puis supprime les candidats. Les locks sont
  acquis dans un ordre déterministe (tri par day, environment) pour éviter
  les deadlocks.
- Les compteurs compactés ne sont **pas** exposés dans le read model
  (`getProductAnalyticsSummary` ne retourne que les totaux).

### Module Core

`packages/core/src/product-analytics/` expose :

- `recordProductAnalyticsEvent` : enregistre un événement raw validé.
- `aggregateProductAnalyticsDays` : agrège une plage `[fromDay, toDayExclusive)`
  en compteurs quotidiens par environnement, avec advisory lock et compaction.
- `purgeExpiredProductAnalytics` : purge les événements raw de plus de 90 jours
  (uniquement si l'agrégat du jour existe) et les agrégats de plus de 24 mois.
  Modèle de compaction : les compteurs compactés accumulent les événements
  supprimés. Idempotente, batchée via `rawLimit`. Advisory lock partagé avec
  l'agrégation. Un agrégat n'est supprimé que si aucun raw ne reste.
- `getProductAnalyticsSummary` : somme les agrégats sur une plage
  `[fromDay, toDayExclusive)` par environnement. Utilise un décodeur bigint
  runtime (`decodeNonNegativeBigInt`) pour valider les valeurs avant
  conversion en number.

## Fichiers livrés

- `packages/database/drizzle/0035_g7h_analytics_foundations.sql` : migration (tables,
  enums, trigger, index).
- `packages/database/drizzle/meta/_journal.json` : entrée idx 34.
- `packages/database/src/schema.ts` : enums et tables Drizzle.
- `packages/database/src/schema-g7h-analytics.test.ts` : tests PostgreSQL du
  schéma (rétention, agrégat, contraintes).
- `packages/database/src/migrate.test.ts` : compteur de migrations mis à jour.
- `packages/core/src/product-analytics/` : `errors.ts`, `types.ts`,
  `validation.ts`, `record-event.ts`, `aggregate.ts`, `purge.ts`, `summary.ts`,
  `index.ts`.
- `packages/core/src/product-analytics/*.test.ts` : tests unitaires.
- `packages/core/src/product-analytics/product-analytics.integration.test.ts` : tests
  d'intégration PostgreSQL.
- `packages/core/src/index.ts` : export additif du module.
- `docs/decisions/ADR-022-product-analytics-privacy-and-retention.md` : décision.
- `docs/architecture/overview.md`,
  `docs/implementation/agent-context.md`,
  `docs/implementation/backlog.md` et
  `docs/implementation/open-questions.md` : statut G7H-A.

## Portée et limites

- L'activation production (envoi d'événements `PRODUCTION`) reste bloquée jusqu'à
  résolution de la question ouverte G7B-R3 (consentement, rétention, validation
  privacy/juridique).
- Aucun provider externe, SDK client, cookie analytics ou UI n'est introduit.
- Aucune dimension démographique, géographique ou d'identification personnelle
  n'est collectée.
