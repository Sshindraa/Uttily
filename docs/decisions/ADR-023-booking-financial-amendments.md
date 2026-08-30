# ADR-023 — Modifications financières append-only des réservations avant retrait

- **Statut** : Accepted — conception approuvée ; G7M C1–C5 livré, validé et fusionné sur `main` ; validation Core/Web/PostgreSQL et CI post-merge vertes. Les remboursements split restent volontairement bloqués tant que leur politique Finance/Juridique n'est pas signée.
- **Date** : 2026-08-10
- **Décideurs** : Porteur produit Uttily, engineering
- **Relie à** : ADR-009, ADR-010, ADR-011, ADR-013, ADR-018 ; G7M/G7P-C
- **Remplace** : la section « Modifications de réservation » reportée de l'ADR-018

## 1. Contexte et problème

### 1.1 Immutabilité confirmée

Les tables `bookings`, `booking_lines` et les snapshots financiers confirmés sont
immuables après confirmation. Les triggers PostgreSQL
`enforce_booking_financial_immutability` et `enforce_booking_line_immutability`
(migration 0033) bloquent toute mutation autre que `status` et `updated_at` sur
`bookings`, et tout `UPDATE` ou `DELETE` sur `booking_lines`. La table
`booking_items` n'a pas de trigger d'immutabilité mais possède une FK NOT NULL
vers `booking_lines.id` et une contrainte `UNIQUE(booking_id, inventory_item_id)`.

### 1.2 Absence de modèle d'amendement

Aucun mécanisme ne permet aujourd'hui de modifier une réservation confirmée.
L'ADR-018 §13 a explicitement reporté les modifications avec variation financière
à un groupe futur (G7M/G7P-C) en attendant une conception paiement/remboursement
séparée.

### 1.3 Impossibilité de modifier directement les lignes confirmées

Pour une ligne `MODIFY` (même variante, quantité différente) :

- `INSERT` dans `booking_lines` viole `UNIQUE(booking_id, variant_id)`.
- `UPDATE` de `booking_lines` est rejeté par le trigger d'immutabilité.

Pour une ligne `ADD` (nouvelle variante) :

- `INSERT` dans `booking_lines` est techniquement possible (nouvelle variante,
  pas de conflit UNIQUE), mais violerait l'intention d'immutabilité du snapshot
  confirmé et rendrait l'historique non auditable.

### 1.4 Nécessité d'un historique append-only

Les modifications doivent être tracées, auditées et réversibles du point de vue
documentaire. Chaque amendement est un nouvel enregistrement qui décrit l'état
effectif après modification, sans altérer les snapshots originaux.

### 1.5 Risques adressés

- **Disponibilité** : chevauchement avec les blocs BOOKING existants de la même
  réservation (la contrainte `no_overlapping_blocks` est aveugle à `source_id`).
- **Paiement** : appel Stripe avant persistance durable de l'intention locale.
- **Remboursement** : dette échouée qui disparaîtrait silencieusement.
- **Idempotence** : double soumission, replay, crash mid-flight.
- **Concurrence** : deadlock entre application, expiration, webhook, fulfillment
  et compensation.

## 2. Périmètre

### 2.1 Inclus

- Réservation `CONFIRMED` uniquement.
- Changements de dates, durée, quantité, variantes et allocations.
- Trois types d'amendement : `NEUTRAL`, `SUPPLEMENT`, `REFUND`.
- Dashboard loueur pour l'initiation de l'amendement.
- Paiement client minimal du supplément via Stripe Elements (réutilisation de
  l'API PaymentIntents et du composant `PaymentElement` existants ; aucun nouveau
  produit Stripe).
- Remboursement sur le moyen de paiement d'origine via Stripe `createRefund`.
- Documents d'amendement générés par un nouveau pipeline outbox.
- Devise EUR uniquement.

### 2.2 Exclus

- Modification à partir de `READY_FOR_PICKUP` ou tout statut ultérieur.
- Rôle `STAFF` pour l'initiation.
- Paiement cross-currency.
- Annulation volontaire générale (hors de cet ADR, soumise à une décision
  séparée).
- Refonte globale des paiements (`payments.draft_id` reste NOT NULL + UNIQUE).
- Stripe Hosted Checkout, Payment Links et Terminal.
- Photos et analytics (G7F/G7H restent inchangés).
- Parcours client complet d'auto-service : le loueur initie, le client accède
  seulement au paiement sécurisé du supplément.
- Réécriture des snapshots originaux (`bookings`, `booking_lines`,
  `booking_items` ne sont jamais mutés par un amendement).

## 3. Modèle append-only conceptuel

### 3.1 Tables d'amendement

```text
booking_amendments
  - id (UUID PK)
  - organization_id (FK organizations)
  - booking_id (FK bookings)
  - amendment_number (INTEGER, monotone par booking)
  - type (NEUTRAL | SUPPLEMENT | REFUND)
  - status (HOLD_PENDING | READY_TO_APPLY | APPLIED | EXPIRED | CANCELLED | FAILED)
  - financial_snapshot_before (JSONB, immutable)
  - financial_snapshot_after (JSONB, immutable)
  - new_customer_start_at, new_customer_end_at
  - new_blocked_start_at, new_blocked_end_at
  - hold_deadline (timestamptz, nullable — uniquement SUPPLEMENT)
  - created_by (FK users)
  - created_at, updated_at, applied_at, expired_at

booking_amendment_lines
  - id (UUID PK)
  - amendment_id (FK booking_amendments)
  - organization_id (FK organizations)
  - logical_line_id (UUID NOT NULL — identité stable)
  - origin_type (ORIGINAL | AMENDMENT)
  - source_booking_line_id (FK booking_lines, nullable — ORIGINAL uniquement)
  - variant_id (FK product_variants)
  - action (ADD | MODIFY | REMOVE | UNCHANGED)
  - before_quantity, before_unit_price_amount_minor, before_line_total_amount_minor
  - after_quantity, after_unit_price_amount_minor, after_line_total_amount_minor
  - pricing_snapshot (JSONB, immutable)
  - variant_snapshot (JSONB, immutable)
  - UNIQUE(amendment_id, logical_line_id)
  - UNIQUE(amendment_id, variant_id)

booking_amendment_allocations
  - id (UUID PK)
  - amendment_id (FK booking_amendments)
  - amendment_line_id (FK booking_amendment_lines)
  - organization_id (FK organizations)
  - inventory_item_id (FK inventory_items)
  - action (RETAIN | ADD | REMOVE | REPLACE)
  - source_booking_block_id (FK inventory_blocks, nullable)
  - applied_booking_block_id (FK inventory_blocks, nullable)
  - status (PROPOSED | CONVERTED | RELEASED | EXPIRED)
  - effective_customer_start_at, effective_customer_end_at
  - effective_blocked_start_at, effective_blocked_end_at
  - UNIQUE(amendment_id, inventory_item_id)

booking_amendment_segments
  - id (UUID PK)
  - allocation_id (FK booking_amendment_allocations)
  - organization_id (FK organizations)
  - inventory_item_id (FK inventory_items)
  - hold_block_id (FK inventory_blocks, UNIQUE)
  - delta_start_at, delta_end_at
  - status (PROPOSED | CONVERTED | RELEASED | EXPIRED)
```

### 3.2 Paiements et attempts de supplément

Tables dédiées `amendment_payments` et `amendment_payment_attempts` isolent le
flux supplément du flux de paiement initial. `payments.draft_id` reste NOT NULL
+ UNIQUE ; les 30+ références existantes restent intactes. Le `stripe-adapter`
(`createPaymentIntent`, `createRefund`) est réutilisé sans modification.

### 3.3 Obligations de remboursement

La table `refunds` existante est étendue pour référencer indifféremment le
paiement initial ou le paiement de supplément. Le modèle conceptuel est :

- `refunds.payment_id` devient nullable (FK vers `payments.id`).
- `refunds.amendment_payment_id` est ajouté, nullable (FK vers
  `amendment_payments.id`).
- Contrainte XOR : exactement une des deux origines est non-null.
- `BOOKING_MODIFICATION` référence `payment_id` (paiement initial).
- `AMENDMENT_COMPENSATION` référence `amendment_payment_id` (paiement de
  supplément).
- Triggers de cohérence : organisation, devise, environnement et montant
  identiques entre le refund et son origine de paiement.
- La projection financière agrège les deux origines.

L'enum `refund_reason` est étendu avec `BOOKING_MODIFICATION` et
`AMENDMENT_COMPENSATION`. L'enum `refund_status` est étendu avec
`FAILED_REQUIRES_MANUAL_ACTION` et `SETTLED_OFF_PLATFORM`. Voir §10 et §11.

### 3.4 Documents amendés

Un nouveau type d'événement outbox `BOOKING_AMENDED.v1` déclenche la génération
d'un document d'amendement par le worker existant. Le pipeline documentaire
existant (ADR-013) est réutilisé avec un nouveau parser. Les documents de
confirmation originaux restent basés sur le snapshot original et ne sont jamais
régénérés.

### 3.5 Règles obligatoires

- Pour une ligne originale, `logical_line_id = booking_line.id` (identité 1:1).
- Pour une ligne ajoutée, `logical_line_id = gen_random_uuid()` ; cet UUID est
  conservé par tous les amendements suivants qui référencent cette même ligne
  logique.
- Une ligne d'origine `AMENDMENT` peut être `UNCHANGED`, `MODIFY` ou `REMOVE`
  sans `source_booking_line_id` (celui-ci est NULL car la ligne n'existe pas
  dans `booking_lines`).
- Les contraintes futures doivent dépendre de `origin_type`, pas supposer que
  toute modification possède une `booking_line` originale.
- Aucun `INSERT`/`UPDATE` artificiel dans `booking_lines` ou `booking_items`
  pour représenter l'état amendé.
- La projection d'amendement devient l'autorité de l'état effectif après
  amendement.
- Aucune variable de session PostgreSQL n'est utilisée pour contourner
  l'intégrité. Les triggers futurs valident l'amendement par les colonnes et
  FK standards.

## 4. Projection canonique

### 4.1 `getEffectiveBooking`

La fonction `getEffectiveBooking(bookingId)` est l'unique autorité de lecture
pour l'état effectif d'une réservation. Elle retourne :

- **Booking original** si aucun amendement `APPLIED` n'existe.
- **Dernier snapshot complet `APPLIED`** sinon (les amendements sont ordonnés
  par `amendment_number`).
- **Dates effectives** : `new_customer_start_at` / `new_customer_end_at` /
  `new_blocked_start_at` / `new_blocked_end_at` du dernier APPLIED, ou dates
  originales.
- **Lignes effectives** : lignes du dernier amendement APPLIED avec
  `action <> 'REMOVE'`, ou `booking_lines` originales.
- **Allocations effectives** : allocations du dernier amendement APPLIED avec
  `status = 'CONVERTED'`, ou `booking_items` originaux.
- **Total contractuel effectif** : `financial_snapshot_after.totalAmountMinor`
  du dernier APPLIED, ou `bookings.totalAmountMinor`.
- **Paiements initiaux et suppléments** : `SUM(payments.amount_minor WHERE
  SUCCEEDED)` + `SUM(amendment_payments.amount_minor WHERE SUCCEEDED)`.
- **Remboursements réussis** : `SUM(refunds.amount_minor WHERE status =
  'SUCCEEDED')` sur les paiements initiaux et suppléments.
- **Remboursements encore dus** : `SUM(refunds.amount_minor WHERE status IN
  ('PENDING', 'SUBMITTED', 'FAILED_REQUIRES_MANUAL_ACTION'))`.
- **Historique complet** : liste ordonnée des amendements pour audit.

### 4.2 Consommateurs à migrer

| Consommateur | Fichier | Stratégie |
| --- | --- | --- |
| Liste opérationnelle | `fulfillment/read-models.ts` `listOperationalBookings` | Utiliser `getEffectiveBooking` |
| Détail opérationnel | `fulfillment/read-models.ts` `getOperationalBookingDetails` | Utiliser `getEffectiveBooking` |
| Transitions fulfillment | `fulfillment/apply-fulfillment-transition.ts` | Valider contre l'état effectif |
| Rapport d'état | `fulfillment/create-condition-report.ts` | Accepter `amendment_allocation_id` (après migration) |
| Rapport de dommage | `fulfillment/create-damage-report.ts` | Accepter `amendment_allocation_id` (après migration) |
| Documents amendés | Nouveau pipeline outbox `BOOKING_AMENDED.v1` | Lire la projection d'amendement |

### 4.3 Documents originaux inchangés

`load-document-render-data.ts` continue de lire `bookings`, `booking_lines` et
`booking_items` originaux. Les documents de confirmation (contrat, confirmation,
reçu) ne sont jamais altérés par un amendement. Les documents amendés sont des
nouveaux documents générés par un pipeline séparé.

## 5. Machines à états séparées

Trois machines indépendantes évitent de coupler l'application de l'amendement,
le paiement du supplément et l'obligation de remboursement.

### 5.1 Application de l'amendement

```text
HOLD_PENDING → READY_TO_APPLY → APPLIED
HOLD_PENDING → EXPIRED
HOLD_PENDING → CANCELLED
READY_TO_APPLY → APPLIED
READY_TO_APPLY → EXPIRED
READY_TO_APPLY → FAILED
```

- `HOLD_PENDING` : hold créé (SUPPLEMENT uniquement), en attente de paiement ou
  d'application directe.
- `READY_TO_APPLY` : paiement réussi (SUPPLEMENT) ou pas de paiement requis
  (NEUTRAL/REFUND), prêt à appliquer.
- `APPLIED` : amendement appliqué, blocks modifiés (terminal).
- `EXPIRED` : hold expiré avant application (terminal).
- `CANCELLED` : annulé par le loueur (terminal).
- `FAILED` : application impossible après paiement (terminal, compensation
  requise).

La migration 0037 (`G7M-C4-S`) rend `READY_TO_APPLY → EXPIRED` explicite dans
le trigger PostgreSQL tout en conservant l'immutabilité des états terminaux.
Le code d'expiration C4-A qui décidera quand effectuer cette transition reste
à implémenter.

**Par type** :

- `NEUTRAL` : créé directement en `READY_TO_APPLY`, application atomique
  immédiate, pas de `HOLD_PENDING`.
- `REFUND` : créé directement en `READY_TO_APPLY`, application atomique
  immédiate + obligation `PENDING` dans la même transaction.
- `SUPPLEMENT` : créé en `HOLD_PENDING`, transition vers `READY_TO_APPLY` après
  webhook `payment_intent.succeeded`.

### 5.2 Paiement du supplément

```text
PENDING_PROVIDER → REQUIRES_PAYMENT_METHOD → PROCESSING → SUCCEEDED
PENDING_PROVIDER → REQUIRES_ACTION → PROCESSING → SUCCEEDED
PENDING_PROVIDER → FAILED
PROCESSING → SUCCEEDED | FAILED | CANCELLED
FAILED → PENDING_PROVIDER (uniquement avec un nouvel attempt N+1)
```

Le webhook est l'autorité pour le statut final. La réconciliation replaye
`createPaymentIntent` avec la même `provider_idempotency_key` uniquement si
l'attempt n'a pas de `provider_payment_intent_id` **et** que
`hold_deadline` n'est pas encore dépassée. Après `hold_deadline`, aucun nouveau
PaymentIntent n'est créé : le hold expire, le PaymentIntent existant est annulé
si encore annulable, et un éventuel succès tardif est compensé (voir §7.5 et
§7.6). La fenêtre d'idempotence fournisseur (24 h côté Stripe) est une
propriété technique qui ne doit jamais autoriser un retry après expiration du
hold.

Le trigger de la migration 0037 autorise le seul reset contrôlé
`FAILED → PENDING_PROVIDER` si, dans la même transaction, un unique attempt
non terminal `PENDING_PROVIDER` N+1 vient d'être créé avec
`provider_payment_intent_id` et `provider_status` à NULL. Sans nouvel attempt,
avec un numéro non croissant, plusieurs attempts non terminaux, un provider
déjà renseigné ou depuis `SUCCEEDED`/`CANCELLED`, la transition est rejetée.
Les attempts terminaux et les snapshots du paiement restent immuables.

### 5.3 Obligation de remboursement

```text
PENDING → SUBMITTED → SUCCEEDED
PENDING → FAILED_REQUIRES_MANUAL_ACTION
SUBMITTED → SUCCEEDED | FAILED_REQUIRES_MANUAL_ACTION
FAILED_REQUIRES_MANUAL_ACTION → SETTLED_OFF_PLATFORM
```

- `PENDING` : obligation créée, pas encore soumise à Stripe.
- `SUBMITTED` : `createRefund` accepté par Stripe, en attente du webhook.
- `SUCCEEDED` : remboursement réussi (terminal).
- `FAILED_REQUIRES_MANUAL_ACTION` : Stripe a refusé définitivement ; la dette
  reste visible et auditée (terminal côté Stripe, résoluble manuellement).
- `SETTLED_OFF_PLATFORM` : réglé hors plateforme par intervention manuelle
  auditée (terminal).

Aucune annulation rétroactive de l'amendement n'est effectuée si le
remboursement échoue. L'amendement reste `APPLIED` et la dette est tracée.

## 6. NEUTRAL et REFUND — application atomique directe

Aucun fournisseur externe n'est attendu avant l'application pour `NEUTRAL` ou
`REFUND`. L'application est synchrone et atomique dans une unique transaction
PostgreSQL. Aucun hold temporaire n'est nécessaire.

### 6.1 Transaction unique (NEUTRAL)

1. `lockOrganization` (advisory).
2. `lockKey` (idempotency).
3. `SELECT booking FOR UPDATE` → vérifier `status = CONFIRMED`.
4. `SELECT booking_amendments FOR UPDATE` → refuser si amendement actif.
5. `SELECT inventory_blocks FOR UPDATE ORDER BY id` (blocks existants
   concernés).
6. Vérifier disponibilité des nouvelles plages (`NOT EXISTS` overlap en
   excluant les blocks de ce booking).
7. Marquer blocks `BOOKING` existants concernés → `RELEASED`.
8. Créer nouveaux blocks `BOOKING/ACTIVE` (pleine plage effective).
9. `UPDATE amendment → APPLIED`.
10. `INSERT outbox BOOKING_AMENDED.v1`.
11. `completeKey`.

### 6.2 Transaction unique (REFUND)

Identique à NEUTRAL, avec en plus à l'étape 9 :

- `INSERT refunds (reason = 'BOOKING_MODIFICATION', status = 'PENDING',
  provider_idempotency_key)`.
- `INSERT outbox REFUND_REQUESTED.v1`.

L'obligation de remboursement est créée dans la même transaction que
l'application. L'amendement est `APPLIED` et le refund est `PENDING`. Le worker
outbox traitera le refund ultérieurement via Stripe (hors transaction).

### 6.3 Pourquoi pas de hold ?

Le hold sert à protéger des dates pendant une **pause externe** (attente
paiement). Pour NEUTRAL/REFUND, il n'y a aucune pause externe. L'application est
synchrone et atomique. La protection est assurée par :

1. Le verrou `FOR UPDATE` sur les blocks existants.
2. La contrainte `EXCLUDE` sur les nouveaux blocks.
3. L'atomicité de la transaction.

Si un concurrent tente de réserver les mêmes dates pendant la transaction, il
est bloqué par les locks `FOR UPDATE` ou rejeté par la contrainte `EXCLUDE`.

## 7. SUPPLEMENT — hold delta-segment et paiement client

### 7.1 Création locale durable avant Stripe

1. `lockOrganization` → `lockKey` → `SELECT booking FOR UPDATE` → vérifier
   `CONFIRMED` → `SELECT booking_amendments FOR UPDATE` → refuser si actif.
2. Calculer les delta-segments (voir §8).
3. Créer blocks `HOLD/ACTIVE` pour les delta-segments (`expiresAt = now +
   10 min`).
4. `INSERT booking_amendments (HOLD_PENDING, hold_deadline = now + 10 min)`.
5. `INSERT booking_amendment_lines` (snapshot complet).
6. `INSERT booking_amendment_allocations (PROPOSED)`.
7. `INSERT booking_amendment_segments (PROPOSED)`.
8. `INSERT amendment_payments (PENDING_PROVIDER)`.
9. `INSERT amendment_payment_attempt (PENDING_PROVIDER,
   provider_idempotency_key)`.
10. `INSERT outbox BOOKING_AMENDMENT_REQUESTED.v1`.
11. `completeKey`.
12. **Hors transaction** : `stripe.createPaymentIntent(delta_amount,
    provider_idempotency_key, metadata)` où `metadata` contient
    `payment_type = 'AMENDMENT'`, `amendment_payment_attempt_id`,
    `amendment_id` et l'environnement attendu. Ces metadata permettent au
    webhook précoce de résoudre l'attempt même si
    `provider_payment_intent_id` n'a pas encore été projeté (voir §10.4).
13. Transaction B : projeter la réponse synchrone sur
    `amendment_payments` et `amendment_payment_attempts` uniquement
    (`provider_payment_intent_id`, `provider_status`). L'amendement reste
    `HOLD_PENDING` jusqu'au webhook `payment_intent.succeeded`, puis passe à
    `READY_TO_APPLY`.
14. Retourner `client_secret` au frontend.

### 7.2 Hold delta-segment de 10 minutes

L'ancien booking reste effectif pendant le paiement. **Uniquement les segments
supplémentaires** (non déjà couverts par les blocks `BOOKING` existants de cette
réservation pour le même item) sont placés en `HOLD/ACTIVE`. Voir §8 pour le
calcul des delta-segments.

### 7.3 Paiement client via Stripe Elements

Le loueur initie l'amendement. Le **client lié à la réservation** est le seul
autorisé à ouvrir et confirmer le paiement. Le futur contrat d'accès doit être
authentifié et tenant-safe ; un UUID seul n'est pas une autorisation. La route
cliente réutilise Stripe Elements (`PaymentElement`, `stripe.confirmPayment`
avec `redirect: 'if_required'`) — aucun nouveau produit Stripe. La SCA/3DS est
gérée automatiquement par Stripe.js.

### 7.4 Webhook et réconciliation idempotents

- Webhook `payment_intent.succeeded` → `UPDATE amendment → READY_TO_APPLY` →
  application atomique (transaction D).
- Webhook `payment_intent.payment_failed` → `UPDATE amendment_payment → FAILED`.
  Si l'amendement n'est pas expiré, retry possible.
- Réconciliation rapide : replay `createPaymentIntent` avec la même
  `provider_idempotency_key` si l'attempt n'a pas de
  `provider_payment_intent_id` **et** que `hold_deadline` n'est pas encore
  dépassée. Après `hold_deadline`, aucun nouveau PaymentIntent n'est créé ;
  le hold expire (voir §7.5) et un éventuel succès tardif est compensé
  (voir §7.6).

### 7.5 Expiration ferme

`hold_deadline = created_at + 10 minutes` (non négociable). Le cron d'expiration
verrouille l'amendement (`FOR UPDATE`) et, si `projectionAt >= holdDeadline` et
`status IN (HOLD_PENDING, READY_TO_APPLY)`, expire atomiquement : `HOLD blocks → EXPIRED`,
`amendment_segments → EXPIRED`, `amendment → EXPIRED`,
`INSERT outbox BOOKING_AMENDMENT_EXPIRED.v1`.

La condition et l'orchestration d'expiration sont implémentées par C4-A dans
`expireSupplementAmendmentsBatch`, avec une horloge capturée une fois, un batch
borné `FOR UPDATE SKIP LOCKED`, des verrous tenant-scoped et une outbox
idempotente. C4-B implémente la compensation atomique et le câblage opérationnel.

### 7.6 Paiement tardif → compensation automatique

Si le webhook `payment_intent.succeeded` arrive après l'expiration :

- Le webhook détecte `amendment.status = EXPIRED` et C3 projette le paiement et
  l'attempt en succès sans appliquer l'amendement.
- C3 retourne le résultat interne `LATE_SUCCESS_REQUIRES_COMPENSATION` ; C4
  déclenche `compensateAmendmentPayment` : `INSERT refunds (reason =
  'AMENDMENT_COMPENSATION', status = 'PENDING')`, `INSERT outbox
  REFUND_REQUESTED.v1`.
- Le worker outbox exécute `stripe.createRefund` (hors transaction).
- Le webhook refund projette le statut final.

### 7.7 Aucun stock immobilisé sans borne

Le stock n'est jamais immobilisé plus de `hold_deadline + 5 min` (watchdog pour
les états zombies `READY_TO_APPLY` non appliqués).

## 8. Disponibilité et allocations

### 8.1 Règle delta

```
delta = nouvelle plage − plages BOOKING déjà détenues par cette réservation
        pour le même inventory_item_id
```

Seuls les segments delta sont placés en `HOLD/ACTIVE`. Les segments non-delta
restent protégés par les blocks `BOOKING` existants. À l'application, les blocks
`BOOKING` existants sont marqués `RELEASED` pour `REPLACE`/`REMOVE`, les `HOLD`
delta sont marqués `CONVERTED`, et de nouveaux blocks `BOOKING/ACTIVE` sont
créés pour `ADD`/`REPLACE` ; `RETAIN` conserve le block source et l'utilise
comme `applied_booking_block_id`.

### 8.2 Scénarios

| Scénario | Ancien block | Delta réservé | À l'application |
| --- | --- | --- | --- |
| Prolongation [d1-d3]→[d1-d5] | BOOKING [d1-d3] | HOLD [d3-d5] | Release BOOKING [d1-d3], créer BOOKING [d1-d5] |
| Réduction [d1-d5]→[d1-d3] | BOOKING [d1-d5] | Aucun delta | Release BOOKING [d1-d5], créer BOOKING [d1-d3] |
| Déplacement partiel [d1-d3]→[d2-d4] | BOOKING [d1-d3] | HOLD [d3-d4] | Release BOOKING [d1-d3], créer BOOKING [d2-d4] |
| Déplacement distinct [d1-d3]→[d5-d7] | BOOKING [d1-d3] | HOLD [d5-d7] | Release BOOKING [d1-d3], créer BOOKING [d5-d7] |
| Ajout quantité (item Y nouveau) | BOOKING item X | HOLD item Y [pleine plage] | Créer BOOKING item Y, garder BOOKING item X |
| Retrait quantité (item X) | BOOKING item X | Aucun delta | Release BOOKING item X |
| Ajout variante | — | HOLD [pleine plage] | Créer BOOKING |
| Suppression variante | BOOKING | Aucun delta | Release BOOKING |
| Remplacement item X→Y | BOOKING item X | HOLD item Y [pleine plage] | Release BOOKING X, créer BOOKING Y |

### 8.3 Contrainte EXCLUDE

La contrainte PostgreSQL `no_overlapping_blocks` ne doit jamais être relâchée.
Le protocole delta-segment la respecte par construction : les `HOLD` ne
chevauchent jamais les `BOOKING` existants de la même réservation (seuls les
segments supplémentaires sont réservés).

## 9. Fulfillment

### 9.1 Règles d'exclusion mutuelle

- La transition vers `READY_FOR_PICKUP` refuse tout amendement actif
  (`HOLD_PENDING` ou `READY_TO_APPLY` non `APPLIED`/`EXPIRED`/`CANCELLED`/
  `FAILED`).
- La création d'un amendement refuse tout booking différent de `CONFIRMED`.

### 9.2 Comportement concurrent

- Si fulfillment prend le lock avant qu'un amendement existe, il passe à
  `READY_FOR_PICKUP` ; la création ultérieure de l'amendement échoue (booking
  n'est plus `CONFIRMED`).
- Si un amendement actif existe déjà, `READY_FOR_PICKUP` échoue avec un
  conflit métier.
- Si l'amendement vient d'être `APPLIED` ou est terminal (`EXPIRED`/
  `CANCELLED`/`FAILED`), fulfillment peut continuer après relecture sous lock.

### 9.3 Ordre de locks commun

L'amendement et le fulfillment suivent un ordre de locks commun (voir §12),
commençant par `lockOrganization` puis `bookings`. Aucun deadlock n'est possible
entre les deux flux.

## 10. Paiement et remboursement

### 10.1 DB avant Stripe

Pour le supplément :

- L'intention locale (`amendment_payments`, `amendment_payment_attempt`) est
  persistée dans la transaction A **avant** l'appel Stripe.
- L'appel Stripe (`createPaymentIntent`) est hors transaction.
- La projection de la réponse synchrone est dans la transaction B.
- Si crash avant Stripe : la réconciliation replaye avec la même
  `provider_idempotency_key` uniquement si `hold_deadline` n'est pas encore
  dépassée. Après `hold_deadline`, aucun nouveau PaymentIntent n'est créé.
- Si crash après Stripe mais avant projection : la réconciliation retrieve le
  PaymentIntent et projette. Le webhook peut arriver entre-temps.

G7M-C2 verrouille dans l'ordre organisation, réservation, amendement,
`amendment_payments`, puis `amendment_payment_attempts`. Après le commit de la
transaction A, `createPaymentIntent` ou `retrievePaymentIntent` est appelé hors
transaction ; une transaction B reprend le même ordre et ne projette que
l'identifiant et le statut fournisseur sur l'attempt. Le `clientSecret` reste
éphémère : il est renvoyé depuis la mémoire après le commit de B et n'est
jamais persisté, journalisé ou placé dans l'outbox.

Transaction A capture `startedAt` et borne `processing_deadline_at` au minimum
entre le délai technique et `hold_deadline`. Transaction B capture un
`projectionAt` frais après l'appel provider ; si le hold est expiré à cet
instant, elle retourne `HOLD_EXPIRED` sans projection, en conservant la même
tentative et la même clé d'idempotence pour la récupération ultérieure. La
validation runtime des metadata PaymentIntent est centralisée entre FakeStripe
et StripeAdapter : les variantes initiale et `AMENDMENT` sont des allow-lists
fermées, la variante amendment exige trois UUIDs, `TEST`/`LIVE` et le protocole
`booking-amendment-payment-v1`.

G7M-C4-S (migration 0037) ne crée aucun objet de schéma nouveau. Elle autorise
`READY_TO_APPLY → EXPIRED` et impose le retry
`FAILED → PENDING_PROVIDER` avec un attempt N+1 unique, initialisé sans
provider. Les attempts terminaux et les snapshots du paiement restent
immuables. G7M-C4-A implémente l'expiration, le retry métier et la
réconciliation hors transaction provider ; G7M-C4-B implémente la compensation
atomique `compensateAmendmentPayment`, le câblage du webhook C3, l'extension du
moteur d'exécution des remboursements pour `AMENDMENT_COMPENSATION`, et le
câblage des crons web `expire-holds` et `reconcile-payments`.

### 10.1 bis Commission du supplément

La commission du supplément est un snapshot serveur dérivé des montants
originaux :

```text
round_half_up(supplement_amount_minor * commission_original_minor
              / total_original_minor)
```

Le calcul utilise `bigint`, un arrondi half-up positif et une borne entre zéro
et le supplément. Si le total original vaut zéro, seule une commission
originale nulle est cohérente. Le résultat alimente `application_fee_amount` ;
aucune valeur fournie par le client ne participe au calcul.

Pour le remboursement :

- L'obligation locale (`refunds PENDING`) est persistée dans la transaction
  d'application de l'amendement.
- L'appel Stripe (`createRefund`) est exécuté par le worker outbox hors
  transaction.
- Si crash avant Stripe : le worker retry (lease outbox).
- Si crash après Stripe mais avant projection : le webhook refund projette le
  statut final.

### 10.2 Provider idempotency key

- Supplément : `pi_amendment_${amendment_payment_id}_${attempt_number}`.
- Remboursement : `refund_amendment_${refund_id}`.

### 10.3 Récupération après crash

| Crash | État local | État Stripe | Récupération |
| --- | --- | --- | --- |
| Avant appel Stripe | PENDING_PROVIDER, attempt sans PI | Rien | Réconciliation rapide (avant hold_deadline) : replay createPaymentIntent. Après hold_deadline : expiration du hold. |
| Après Stripe, avant projection | PENDING_PROVIDER, attempt sans PI | PaymentIntent existe | Réconciliation : retrieve + projet. Webhook peut arriver. |
| Webhook avant projection synchrone | attempt sans PI | PI existe | Webhook résout l'attempt via metadata du PaymentIntent (`amendment_payment_attempt_id`). Voir §10.4. |
| Réponse synchrone après webhook | déjà APPLIED | PI succeeded | Transaction B vérifie status : idempotent noop. |

### 10.4 Webhook précoce

Le webhook peut arriver avant la projection synchrone. L'intention locale et
l'attempt existent avant Stripe. Le PaymentIntent porte dans ses metadata un
identifiant local non ambigu : `payment_type = 'AMENDMENT'`,
`amendment_payment_attempt_id`, `amendment_id` et l'environnement attendu.

Le webhook précoce résout l'attempt par cette metadata, puis vérifie l'autorité
fournisseur (signature Stripe), l'organisation, l'environnement et les
montants, même si `provider_payment_intent_id` n'a pas encore été projeté par
la réponse synchrone. La réponse synchrone tardive devient ensuite un no-op
idempotent si le webhook a déjà projeté l'état.

### 10.5 Réconciliation

Le mécanisme Core est étendu par
`reconcileSupplementPaymentsBatch`/`claimSupplementPaymentBatch` pour traiter
les `amendment_payment_attempts` avec le même pattern `SKIP LOCKED` + lease et
fencing. Les appels provider sont hors transaction et hors verrou métier. Le
replay `createPaymentIntent` n'a lieu qu'avant `hold_deadline`. Après
`hold_deadline`, aucun nouveau PaymentIntent n'est créé et le succès provider
n'est jamais appliqué localement par C4-A ; l'expiration traite l'amendement.

### 10.6 Compensation

La compensation des suppléments expirés puis payés tardivement suit le pattern
de `compensate-late.ts` existant : création d'un refund
`AMENDMENT_COMPENSATION`, outbox `REFUND_REQUESTED.v1`, worker
`createRefund`.

### 10.7 Modèle de remboursement étendu

La table `refunds` existante référence le paiement initial via `payment_id`
(NOT NULL aujourd'hui). Pour supporter les amendements, ce modèle est étendu :

- `refunds.payment_id` devient nullable.
- `refunds.amendment_payment_id` est ajouté, nullable (FK vers
  `amendment_payments.id`).
- Contrainte CHECK XOR : exactement une des deux origines est non-null.
- `BOOKING_MODIFICATION` référence `payment_id` (paiement initial).
- `AMENDMENT_COMPENSATION` référence `amendment_payment_id` (paiement de
  supplément concerné).
- Triggers de cohérence : organisation, devise, environnement et montant
  identiques entre le refund et son origine de paiement.
- La projection financière agrège les deux origines (`SUM(refunds.amount_minor
  WHERE payment_id IS NOT NULL)` + `SUM(refunds.amount_minor WHERE
  amendment_payment_id IS NOT NULL)`).

L'enum `refund_status` est étendu avec `FAILED_REQUIRES_MANUAL_ACTION` (dette
visible) et `SETTLED_OFF_PLATFORM` (résolution manuelle auditée). L'enum
`refund_reason` est étendu avec `BOOKING_MODIFICATION` et
`AMENDMENT_COMPENSATION`.

### 10.8 Pas d'annulation rétroactive

Un remboursement `FAILED_REQUIRES_MANUAL_ACTION` reste une dette visible et
auditée. L'amendement n'est pas annulé rétroactivement. La résolution se fait
par intervention manuelle (`SETTLED_OFF_PLATFORM`) tracée par `audit_log`.

## 11. Invariants financiers

### 11.1 Définitions

| Concept | Définition |
| --- | --- |
| Total contractuel effectif | `financial_snapshot_after.totalAmountMinor` du dernier APPLIED, ou `bookings.totalAmountMinor` |
| Encaissé brut | `SUM(payments.amount_minor WHERE SUCCEEDED)` + `SUM(amendment_payments.amount_minor WHERE SUCCEEDED)` |
| Remboursé réussi | `SUM(refunds.amount_minor WHERE status = 'SUCCEEDED')` — agrège les refunds sur paiement initial (`payment_id`) et sur paiement de supplément (`amendment_payment_id`) |
| Remboursement encore dû | `SUM(refunds.amount_minor WHERE status IN ('PENDING', 'SUBMITTED', 'FAILED_REQUIRES_MANUAL_ACTION'))` — agrège les deux origines |
| Encaissé net | Encaissé brut − Remboursé réussi |
| Règlement hors plateforme | `SUM(refunds.amount_minor WHERE status = 'SETTLED_OFF_PLATFORM')` |

### 11.2 Invariant conceptuel

```
encaissé_brut − remboursé_réussi − règlement_hors_plateforme − remboursement_encore_dû
  = total_contractuel_effectif
```

Cet invariant est vrai à tout moment, y compris pendant les états asynchrones,
parce que les obligations `PENDING`, `SUBMITTED` et
`FAILED_REQUIRES_MANUAL_ACTION` sont comptées dans `remboursement_encore_dû`.

### 11.3 Conditions de validité

L'invariant tient quand :

- Tous les paiements et refunds sont associés au bon booking (via
  `payments.draft_id` → `bookings.draft_id` pour les paiements initiaux, via
  `amendment_payments.booking_id` pour les suppléments).
- Aucun refund n'est créé sans une obligation correspondante.
- Chaque refund référence exactement une origine de paiement (`payment_id` XOR
  `amendment_payment_id`), avec cohérence d'organisation, de devise,
  d'environnement et de montant validée par trigger.
- Les compensations de suppléments expirés sont des refunds
  `AMENDMENT_COMPENSATION` référençant `amendment_payment_id`, dont le montant
  compense exactement le supplément payé.

### 11.4 Traitement des compensations de suppléments expirés

Quand un supplément est payé après l'expiration de l'amendement :

- `encaissé_brut` augmente de `delta` (le supplément est réussi).
- `remboursement_encore_dû` augmente de `delta` (refund
  `AMENDMENT_COMPENSATION` PENDING).
- `total_contractuel_effectif` reste `total_initial` (amendement EXPIRED, non
  appliqué).
- Invariant : `total_initial + delta − 0 − 0 − delta = total_initial` ✓

## 12. Ordre global des locks

### 12.1 Ordre conceptuel unique

1. `lockOrganization` (`pg_advisory_xact_lock`) — lorsque disponible.
2. `lockKey` (`idempotency_records FOR UPDATE`).
3. `bookings (FOR UPDATE)`.
4. `booking_amendments (FOR UPDATE)`.
5. `inventory_blocks (FOR UPDATE ORDER BY id)`.
6. `booking_amendment_allocations (FOR UPDATE ORDER BY id)`.
7. `booking_amendment_segments (FOR UPDATE ORDER BY id)`.
8. `refunds (FOR UPDATE)` — si REFUND ou compensation.
9. `amendment_payments (FOR UPDATE)` — si SUPPLEMENT.
10. `payment_webhook_events (FOR UPDATE)` — si webhook.
11. `outbox_events (INSERT)` — pas de `FOR UPDATE`.

### 12.2 Adaptation par flux

| Flux | Locks acquis |
| --- | --- |
| Création SUPPLEMENT | 1→2→3→4→5(HOLD)→6→7→9→11 |
| Création NEUTRAL | 1→2→3→4→5→11 |
| Création REFUND | 1→2→3→4→5→8→11 |
| Application amendement | 1→3→4→5→6→7→11 |
| Expiration cron | 4(SKIP LOCKED)→5→6→7 |
| Webhook supplément | organisation→booking→amendment→blocks→allocations→segments→amendment_payment→amendment_attempt→webhook_event→outbox |
| Webhook refund | 1→8→10→11 |
| Watchdog zombies | 1→4→5→6→7→11 |
| Compensation amendement | outbox claim → 8 → 9 (worker) |

### 12.3 Batch d'expiration

Le batch d'expiration peut sélectionner les amendements avec `SKIP LOCKED` sur
`booking_amendments`. Après sélection, il doit verrouiller et traiter en
transaction l'amendement et **tous** ses blocks. Aucun traitement partiel : si
un block est verrouillé par un autre flux, le cron attend (pas de `SKIP LOCKED`
sur les blocks). L'amendement et ses blocks sont traités atomiquement.

### 12.4 Preuve de non-deadlock (cron vs application)

- Application : locks 1→3→4→5.
- Cron : locks 4 (SKIP LOCKED)→5.

Si l'application tient 4, le cron skip cet amendement. Si le cron acquiert 4,
il tente 5 (libre si l'application n'a pas encore 5). Le cron complète, libère
4. L'application acquiert 4 puis 5. Pas de cycle.

## 13. Autorisation et isolation tenant

### 13.1 Initiation

Seuls les membres actifs avec rôle `OWNER`, `ADMIN` ou `MANAGER` peuvent
initier un amendement. `STAFF` est exclu. L'autorisation est vérifiée côté
serveur par `requireManagerOf` (réutilisation du pattern existant).

### 13.2 Paiement

Le **client authentifié lié à la réservation** (`bookings.customer_user_id`)
est le seul autorisé à ouvrir et confirmer le paiement du supplément. Le futur
contrat d'accès doit être authentifié et tenant-safe : un UUID seul n'est pas
une autorisation. La vérification lie l'identité Clerk, l'appartenance
d'organisation (si applicable) et le `customer_user_id` de la réservation.

### 13.3 Webhook et worker

Les webhooks Stripe sont vérifiés par signature (pattern existant
`verifyWebhook`). Le worker outbox est une autorité système vérifiée par lease
+ fencing token (pattern existant).

### 13.4 Toutes les tables et requêtes futures sont organization-scoped

Toutes les tables d'amendement portent `organization_id` NOT NULL FK vers
`organizations`. Les triggers futurs de cohérence tenant valident que
l'amendement, ses lignes, ses allocations et ses segments appartiennent à la
même organisation que le booking.

### 13.5 Aucun identifiant opaque comme unique mécanisme d'autorisation

Un `amendment_id` ou `booking_id` passé en paramètre URL ne constitue pas une
autorisation. Toute route cliente doit vérifier l'identité authentifiée et le
lien avec la réservation.

## 14. Conséquences et migrations futures

Cette ADR décrit la conception approuvée. Les migrations et implémentations
ne sont pas créées dans ce cycle. Les conséquences à anticiper pour le lot
d'implémentation :

- **Nouvelles tables d'amendement** : `booking_amendments`,
  `booking_amendment_lines`, `booking_amendment_allocations`,
  `booking_amendment_segments`.
- **Nouvelles tables de paiement du supplément** : `amendment_payments`,
  `amendment_payment_attempts`.
- **Extension des raisons de remboursement** : `refund_reason` étendu avec
  `BOOKING_MODIFICATION` et `AMENDMENT_COMPENSATION`.
- **Représentation distincte de la résolution manuelle** : `refund_status`
  étendu avec `FAILED_REQUIRES_MANUAL_ACTION` et `SETTLED_OFF_PLATFORM` ;
  colonnes `settled_off_platform_at`, `settled_off_platform_by`,
  `settlement_notes` sur `refunds`.
- **Relation refunds / amendment_payments** : `refunds.payment_id` devient
  nullable, `refunds.amendment_payment_id` est ajouté (nullable, FK vers
  `amendment_payments.id`), contrainte CHECK XOR (exactement une origine
  non-null), triggers de cohérence organisation/devise/environnement/montant.
  `BOOKING_MODIFICATION` référence le paiement initial ;
  `AMENDMENT_COMPENSATION` référence le paiement de supplément.
- **Adaptation condition_reports/damage_reports** : `booking_item_id` devient
  nullable, `amendment_allocation_id` est ajouté avec CHECK "exactement une
  référence non-null". Les triggers de cohérence sont étendus.
- **Projection canonique** : `getEffectiveBooking` implémenté dans
  `packages/core`.
- **Modifications fulfillment** : `read-models.ts`,
  `apply-fulfillment-transition.ts`, `create-condition-report.ts`,
  `create-damage-report.ts` migrés vers la projection.
- **Worker/outbox/webhooks** : extension du webhook handler pour les
  `amendment_payments`, extension du worker pour les refunds
  `BOOKING_MODIFICATION` et `AMENDMENT_COMPENSATION`, extension de la
  réconciliation pour les `amendment_payment_attempts`.
- **Route Stripe Elements minimale** : nouvelle route cliente
  `/checkout/amendment/[amendmentId]` réutilisant `PaymentElement` et
  `stripe.confirmPayment`, avec authentification du client lié.
- **Documents amendés** : nouveau type outbox `BOOKING_AMENDED.v1`, nouveau
  parser, nouveau pipeline de génération.
- **Tests PostgreSQL de concurrence** : voir §15.

## 15. Tests futurs obligatoires

Au minimum :

1. **Isolation tenant** : un amendement d'une organisation ne peut pas
   référencer le booking d'une autre.
2. **Autorisations par rôle** : OWNER/ADMIN/MANAGER acceptés, STAFF refusé,
   client non lié refusé.
3. **Idempotence replay/conflict** : même clé + même payload → REPLAY ; même
   clé + payload différent → CONFLICT.
4. **Plusieurs amendements successifs** : l'amendement N+1 hérite les
   `logical_line_id` de l'amendement N.
5. **Ligne ADD puis MODIFY puis REMOVE** : `logical_line_id` stable,
   `origin_type = AMENDMENT`, pas de `source_booking_line_id`.
6. **Delta segments** : prolongation, réduction, déplacement partiel,
   déplacement distinct — vérifier les blocks créés.
7. **Contrainte EXCLUDE réelle** : tentative de chevauchement avec un autre
   booking → rejet.
8. **NEUTRAL atomique** : application synchrone, pas de hold, blocks remplacés
   atomiquement.
9. **REFUND atomique + dette** : application + obligation PENDING dans la même
   transaction ; refund `BOOKING_MODIFICATION` référence `payment_id` ;
   refund `FAILED_REQUIRES_MANUAL_ACTION` reste dû.
10. **Supplément avec SCA** : `REQUIRES_ACTION` → `stripe.confirmPayment` →
    `SUCCEEDED`.
11. **Expiration et paiement tardif** : cron expire, webhook arrive après →
    compensation automatique.
12. **Webhook/cron concurrents** : premier qui gagne le lock procède, l'autre
    s'adapte.
13. **Amendement/READY_FOR_PICKUP concurrents** : un seul gagne, l'autre est
    refusé (conflit métier).
14. **Absence de deadlock** : 3 connexions simultanées (application + webhook +
    fulfillment), `Promise.allSettled`, aucun deadlock, timeout 30 s.
15. **Projection fulfillment** : `getEffectiveBooking` reflète l'état amendé.
16. **Rapports condition/dommage** : créés sur `amendment_allocation_id` pour
    un item d'amendement.
17. **Documents originaux et amendés** : documents originaux inchangés,
    document amendé généré par le nouveau pipeline.
18. **Relation refunds / amendment_payments** : `refunds.payment_id` XOR
    `amendment_payment_id` ; `BOOKING_MODIFICATION` référence le paiement
    initial, `AMENDMENT_COMPENSATION` référence le paiement de supplément ;
    trigger de cohérence organisation/devise/montant.

## 16. Décisions produit enregistrées

Les décisions produit suivantes sont approuvées et inscrites dans cet ADR :

1. Seuls `OWNER`, `ADMIN` et `MANAGER` actifs peuvent initier un amendement.
   `STAFF` est exclu.
2. Les amendements `NEUTRAL` sans variation de prix sont autorisés.
3. Les suppléments sont inclus dans le périmètre cible avec une UI client
   minimale réutilisant Stripe Elements. Aucun nouveau produit Stripe.
4. Le hold d'un supplément dure 10 minutes.
5. Un remboursement définitivement échoué reste une dette visible et auditée,
   traitée par intervention manuelle. Aucun retour rétroactif à l'ancien
   amendement.
6. Le repricing utilise les plans `ACTIVE` au moment de la modification et crée
   un nouveau snapshot immutable.
7. Les rapports de condition et de dommage pourront référencer une allocation
   d'amendement via une future migration.
8. La transition vers `READY_FOR_PICKUP` est interdite tant qu'un amendement
   actif existe.
9. EUR uniquement.
10. Aucun amendement à partir de `READY_FOR_PICKUP`.
11. Aucun parcours d'auto-service complet : le loueur initie, le client accède
    seulement au paiement sécurisé du supplément.
