# G7M-C4-S — Prérequis de schéma pour expiration et retry

## Statut

G7M-C4-S est implémenté localement dans le worktree C4-A comme prérequis
PostgreSQL uniquement. C1 est livré ; les commits C2 et C3 sont empilés
localement ; C4-A (expiration, retry métier et réconciliation), C4-B
(compensation et wiring) et C5 (UI) restent pending. La validation Core globale
reste pending CI.

Cette phase ne livre aucun worker, cron, webhook, route, UI, migration de
données, compensation ou orchestration de lifecycle.

## Migration 0037

`packages/database/drizzle/0037_g7m_c4_supplement_retry_transitions.sql`
remplace les deux fonctions de trigger existantes, sans nouvelle table,
colonne, enum ou représentation Drizzle :

- `booking_amendments` autorise `READY_TO_APPLY → EXPIRED` avec `expired_at`
  non nul et aucun autre timestamp terminal ; les états terminaux restent
  immuables ;
- `amendment_payments` autorise `FAILED → PENDING_PROVIDER` seulement si la
  transaction contient déjà un unique attempt non terminal N+1
  `PENDING_PROVIDER`, avec `provider_payment_intent_id` et `provider_status` à
  `NULL` ;
- sans nouvel attempt, avec un numéro dupliqué ou non croissant, plusieurs
  nonterminaux, un provider déjà renseigné, un snapshot modifié, ou depuis
  `SUCCEEDED`/`CANCELLED`, la transition est rejetée ;
- les attempts échoués et terminaux ne sont jamais réécrits.

L'insertion d'un attempt conserve l'ordre `max(attempt_number) + 1` déjà imposé
par le trigger G7M-A. La concurrence applicative future doit verrouiller le
paiement avant les attempts ; C4-A définira cette orchestration et sa
réconciliation.

## Preuve exécutée

La suite PostgreSQL dédiée passe 9/9 avec PostgreSQL réel. Elle vérifie les
transitions autorisées/interdites, les états terminaux, les snapshots et
identifiants provider, la sérialisation de deux retries concurrents sans
deadlock, ainsi que l'upgrade réel 0036→0037. Le test d'upgrade vérifie la
conservation d'une donnée historique, l'ajout du hash de 0037 une seule fois et
l'absence de doublon après rejeu.

Aucun résultat Core global ne sera déclaré localement ; sa validation reste
pending CI. Les régressions ciblées C2/C3 passent également 433/433 tests
(61 suites, PostgreSQL réel inclus) ; la suite Core globale n'a pas été lancée.

## Périmètre exclu

Pas de modification de `packages/core`, `apps/web`, worker/cron/webhook, UI,
package ou lockfile. Aucun staging, commit, push ou PR n'est effectué dans
cette phase.
