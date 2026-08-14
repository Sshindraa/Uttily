# G7M-C1 — Création locale durable du SUPPLEMENT

- **Statut** : implémenté — validation ciblée C1/C2 verte, validation globale en attente
- **ADR de référence** : [ADR-023](../decisions/ADR-023-booking-financial-amendments.md), §§7, 8, 10, 12 et 15
- **Migration** : aucune ; le schéma 0036 est suffisant

## Périmètre livré

`createSupplementBookingAmendment` accepte une cible dont le total financier
est strictement supérieur au total effectif et persiste atomiquement :

- l'amendement `SUPPLEMENT/HOLD_PENDING` et ses snapshots immuables ;
- les lignes et allocations `PROPOSED`, avec `logical_line_id` conservé ;
- les delta-segments half-open, déterministes et triés ;
- les holds `ACTIVE` de type `HOLD`, expirant à `hold_deadline` capturée une
  seule fois à dix minutes ;
- `amendment_payments/PENDING_PROVIDER` et la première tentative avec la clé
  `pi_amendment_${amendmentPaymentId}_1` ;
- l'outbox fermée `BOOKING_AMENDMENT_REQUESTED.v1`, dont le payload contient
  uniquement `organizationId`, `bookingId` et `amendmentId`.

La réservation est verrouillée après le verrou organisationnel et les
amendements actifs sont relus sous verrou. L'isolation d'organisation,
l'autorisation OWNER/ADMIN/MANAGER, l'idempotence et l'exclusion PostgreSQL
restent autoritaires. Aucun appel Stripe, client secret, webhook, cron, worker,
UI ou application d'amendement n'est inclus.

## Delta-segments

La soustraction utilise des intervalles half-open `[start, end)`. Les blocs
`BOOKING` actifs de la même réservation et du même exemplaire sont fusionnés
avant soustraction ; les intervalles vides sont supprimés et le résultat est
ordonné par début puis fin. Une modification financièrement positive peut donc
créer zéro, un ou plusieurs holds physiques.

## Preuve

- `packages/core/src/booking-amendments/delta-segments.test.ts` : cas purs de
  fusion, adjacence, multi-segments et couverture complète.
- `packages/core/src/booking-amendments/create-supplement-booking-amendment.integration.test.ts` :
  10 tests PostgreSQL réels : persistance atomique, deadline commune,
  holds delta, tentative/payment `PENDING_PROVIDER`, outbox exacte, replay sans
  duplication, isolation tenant, supplément financier sans delta physique,
  rollback atomique sur conflit externe et concurrence réelle, plus les
  scénarios de quantité, déplacement partiel et remplacement d'item.
- `packages/core/src/booking-amendments/create-supplement-booking-amendment.test.ts` :
  4 tests unitaires de validation pré-DB, classification SUPPLEMENT et clé
  provider déterministe.
- `packages/core/src/booking-amendments/delta-segments.test.ts` : 4 tests
  unitaires de fusion, adjacence, multi-segments et couverture complète.
- `packages/contracts/src/booking-amendment-requested-event.test.ts` : 5 tests
  unitaires du contrat strict et de son payload fermé.
- Contrat strict : `packages/contracts/src/booking-amendment-requested-event.ts`.

La preuve PostgreSQL est obtenue avec `DATABASE_URL` pointant vers PostgreSQL
réel ; le fichier reste explicitement skippable lorsque cette variable est
absente hors CI et ce cas n'est pas compté comme une validation C1.

## Validation locale

- Validation ciblée C1 : verte — contrat 5/5, unitaires delta/C1 8/8,
  PostgreSQL C1 10/10 sans skip. Le dernier périmètre module partagé C1+C2
  passe 191/191 (111 unitaires, 80 PostgreSQL), contre 171/171 lors de la
  validation historique C1 seule.
- Test isolé `expire-booking-drafts-batch.test.ts` : 23/23, sans skip.
- Première suite Core complète : 2 403/2 404, avec un timeout isolé hors C1
  dans `expire-booking-drafts-batch.test.ts` ; elle n'est pas revendiquée
  comme verte.
- Le test isolé d'expiration a ensuite passé 23/23. Une seconde suite Core a
  été interrompue avant son résumé et n'est pas revendiquée.
- La validation Core globale définitive reste **pending CI**.

## Suite G7M-C

- **C1** : implémenté ; validation ciblée verte, validation Core globale
  définitive pending CI.
- **C2** : initiation Stripe et projection synchrone, implémenté et validé dans
  [la note C2](g7m-c2-supplement-payment.md).
- **C3** : webhooks et application atomique, pending.
- **C4** : expiration, réconciliation tardive et compensation, pending.
- **C5** : route cliente Stripe Elements, pending.
