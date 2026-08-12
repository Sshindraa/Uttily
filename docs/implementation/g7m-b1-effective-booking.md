# G7M-B1 — Projection canonique getEffectiveBooking

## Statut

**Livré le 2026-08-11.** Phase read-only, aucune mutation métier, aucune migration.

- Branche : `codex/g7m-b1-effective-booking`
- Base : `origin/main` (`09ec7e477eab9132952e9b5affdd551b89c18102`)
- ADR de référence : ADR-023 §4.1, §11.1
- Prérequis : G7M-A (migration 0036, tables `booking_amendments`, `booking_amendment_lines`, `booking_amendment_allocations`, `amendment_payments`, `refunds`)

## Objectif

Ajouter une projection Core tenant-safe qui retourne l'état contractuel effectif d'une réservation à partir :

- de la réservation originale si aucun amendement APPLIED n'existe ;
- du dernier amendement APPLIED si un ou plusieurs amendements ont été appliqués ;
- de l'historique ordonné des amendements APPLIED ;
- de la projection financière complète (six métriques agrégées depuis deux origines).

Cette phase est strictement read-only. Aucune mutation d'amendement, aucun changement fulfillment, aucun paiement ou remboursement, aucun SUPPLEMENT, aucune UI.

## API publique

### Signature

```typescript
export async function getEffectiveBooking(
  db: DbExecutor,
  organizationId: string,
  bookingId: string,
): Promise<GetEffectiveBookingResult>;
```

`DbExecutor` (importé depuis `@uttily/database`) accepte soit un `DatabaseClient`, soit une `DatabaseTransaction` active. Aucune transaction interne n'est créée — la projection est read-only et peut être appelée dans la transaction d'un appelant (G7M-B2 l'utilisera dans sa propre transaction pour la vérification d'optimistic locking).

### Résultat

Union fermée et tenant-safe :

```typescript
export type GetEffectiveBookingResult =
  | { readonly kind: 'FOUND'; readonly booking: EffectiveBooking }
  | { readonly kind: 'NOT_FOUND' };
```

- `FOUND` : la projection canonique de la réservation.
- `NOT_FOUND` : la réservation n'existe pas OU appartient à une autre organisation. Aucune fuite d'information.

### Erreurs

- `EffectiveBookingError` avec code `VALIDATION` : `organizationId` ou `bookingId` n'est pas un UUID valide. Levée avant toute requête DB.
- `EffectiveBookingError` avec code `SNAPSHOT_INVALID` : le `financial_snapshot_after` JSONB persisté est invalide (non-objet, `totalAmountMinor` non-entier/négatif/dépassant `MAX_SAFE_INTEGER`, `currency` manquante/vide/non-EUR), ou un montant agrégé est non-entier/négatif/dépasse `MAX_SAFE_INTEGER`, ou un block d'inventaire introuvable pour un `booking_item`.
- `EffectiveBookingError` avec code `FINANCIAL_INVARIANT_VIOLATION` : l'invariant financier ADR-023 §11.2 n'est pas satisfait (`grossCollected - successfulRefunded - settledOffPlatform - refundStillOwed ≠ contractualTotal`), ou un des montants n'est pas un entier sûr non-négatif. `getEffectiveBooking` ne retourne jamais une projection incohérente.

Le code `UNKNOWN` a été supprimé — il n'était jamais produit et ne doit pas figurer dans l'API publique.

### Tenant isolation

La requête racine est tenant-scoped : `bookings.id = bookingId AND bookings.organization_id = organizationId`. Une réservation appartenant à une autre organisation produit exactement `NOT_FOUND`, sans révéler son existence. Les tables G7M-A portant `organization_id` (`booking_amendments`, `booking_amendment_lines`, `booking_amendment_allocations`, `amendment_payments`) sont filtrées de manière redondante par `organization_id` pour garantir l'isolation même en cas de jointure croisée.

## Projection

### Booking original (aucun amendement APPLIED)

- `effectiveCustomerStartAt` / `effectiveCustomerEndAt` : `bookings.customer_start_at` / `customer_end_at`
- `effectiveBlockedStartAt` / `effectiveBlockedEndAt` : `bookings.blocked_start_at` / `blocked_end_at`
- `effectiveTotalAmountMinor` : `bookings.total_amount_minor`
- `effectiveCurrency` : `bookings.currency`
- `lines` : `booking_lines` (action `UNCHANGED`, `logicalLineId = booking_line.id`)
- `allocations` : `booking_items` avec dates de `inventory_blocks` (action `RETAIN`, `logicalLineId = booking_items.booking_line_id`)
- `lastAppliedAmendmentNumber` : `0`
- `amendments` : `[]`

### Dernier amendement APPLIED

- Sélection : `max(amendment_number)` puis `max(id)` pour déterminisme
- `effectiveCustomerStartAt` / `effectiveCustomerEndAt` : `new_customer_start_at` / `new_customer_end_at` du dernier APPLIED
- `effectiveBlockedStartAt` / `effectiveBlockedEndAt` : `new_blocked_start_at` / `new_blocked_end_at` du dernier APPLIED
- `effectiveTotalAmountMinor` : `financial_snapshot_after.totalAmountMinor` (JSONB parsé et validé)
- `effectiveCurrency` : `financial_snapshot_after.currency` (JSONB parsé et validé)
- `lines` : `booking_amendment_lines` du dernier APPLIED avec `action <> 'REMOVE'`, ordonnées par `logicalLineId` puis `id`
- `allocations` : `booking_amendment_allocations` du dernier APPLIED avec `status = 'CONVERTED'`, join vers `booking_amendment_lines` pour récupérer `logical_line_id`, ordonnées par `logicalLineId` puis `inventoryItemId` puis `id`
- `lastAppliedAmendmentNumber` : `amendment_number` du dernier APPLIED
- `amendments` : tous les APPLIED ordonnés par `amendmentNumber` puis `id`

### Lignes

- `action = 'REMOVE'` : exclue de la projection
- `action = 'ADD'` / `'MODIFY'` / `'UNCHANGED'` : incluse avec `quantity = afterQuantity`, `unitPriceAmountMinor = afterUnitPriceAmountMinor`, `lineTotalAmountMinor = afterLineTotalAmountMinor`
- `variantSnapshot` : retourné tel quel (JSONB opaque côté Core)

### Allocations

- `status = 'CONVERTED'` : incluse
- `status = 'PROPOSED'` / `'RELEASED'` / `'EXPIRED'` : exclue
- `action = 'RETAIN'` / `'ADD'` / `'REPLACE'` : mappé tel quel
- `action = 'REMOVE'` : ne peut pas être `CONVERTED` (contrainte trigger 0036), donc toujours exclue
- `logicalLineId` :
  - projection originale : `booking_items.booking_line_id` (= identité logique de la ligne originale)
  - projection amendée : `booking_amendment_lines.logical_line_id` (via join `booking_amendment_allocations.amendment_line_id` → `booking_amendment_lines.id`)

### Ordering

- `amendments` : `amendmentNumber` puis `id`
- `lines` (amendement) : `logicalLineId` puis `id`
- `lines` (original) : `id`
- `allocations` (amendement) : `logicalLineId` puis `inventoryItemId` puis `id`
- `allocations` (original) : `bookingLineId` puis `inventoryItemId` puis `id`

## Projection financière (ADR-023 §4.1, §11.1)

### Structure

```typescript
export interface EffectiveFinancials {
  readonly contractualTotalAmountMinor: number;
  readonly grossCollectedAmountMinor: number;
  readonly successfulRefundedAmountMinor: number;
  readonly refundStillOwedAmountMinor: number;
  readonly settledOffPlatformAmountMinor: number;
  readonly netCollectedAmountMinor: number;
  readonly currency: 'EUR';
}
```

### Métriques et origines

Deux origines de paiement, deux origines de refund, agrégées séparément sans produit cartésien :

| Métrique | Origine 1 (paiement initial) | Origine 2 (amendment_payments) | Calcul |
|---|---|---|---|
| `contractualTotalAmountMinor` | — | — | Dernier `financial_snapshot_after.totalAmountMinor` APPLIED, sinon `bookings.totalAmountMinor` |
| `grossCollectedAmountMinor` | `payments.amountMinor` WHERE `status = 'SUCCEEDED'` et `id = bookings.paymentId` | `SUM(amendment_payments.amountMinor)` WHERE `status = 'SUCCEEDED'` et `booking_id = bookingId` et `organization_id = orgId` | Origine 1 + Origine 2 |
| `successfulRefundedAmountMinor` | `SUM(refunds.amountMinor)` WHERE `payment_id = bookings.paymentId` et `status = 'SUCCEEDED'` | `SUM(refunds.amountMinor)` WHERE `amendment_payment_id IN (amendment_payments de cette booking)` et `status = 'SUCCEEDED'` | Origine 1 + Origine 2 |
| `refundStillOwedAmountMinor` | `SUM(refunds.amountMinor)` WHERE `payment_id = bookings.paymentId` et `status IN ('PENDING', 'SUBMITTED', 'FAILED_REQUIRES_MANUAL_ACTION')` | `SUM(refunds.amountMinor)` WHERE `amendment_payment_id IN (...)` et `status IN (...)` | Origine 1 + Origine 2 |
| `settledOffPlatformAmountMinor` | `SUM(refunds.amountMinor)` WHERE `payment_id = bookings.paymentId` et `status = 'SETTLED_OFF_PLATFORM'` | `SUM(refunds.amountMinor)` WHERE `amendment_payment_id IN (...)` et `status = 'SETTLED_OFF_PLATFORM'` | Origine 1 + Origine 2 |
| `netCollectedAmountMinor` | — | — | `grossCollectedAmountMinor - successfulRefundedAmountMinor` |

### Absence de double comptage

Chaque agrégation est une requête `SUM` séparée sur la table `refunds` ou `amendment_payments`, filtrée par `payment_id` ou `amendment_payment_id`. Il n'y a aucune jointure entre `payments`, `amendment_payments` et `refunds` dans une même requête — donc aucun risque de produit cartésien ou de multiplication de lignes.

Les IDs des `amendment_payments` de cette booking sont collectés une fois, puis utilisés dans un `IN (...)` pour filtrer les refunds d'origine 2. Si aucun `amendment_payment` n'existe, les requêtes d'origine 2 sont skipées (zéro).

### SETTLED_OFF_PLATFORM séparé

`SETTLED_OFF_PLATFORM` est compté dans `settledOffPlatformAmountMinor` et **pas** dans `refundStillOwedAmountMinor` (qui ne couvre que `PENDING`, `SUBMITTED`, `FAILED_REQUIRES_MANUAL_ACTION`). Cela permet de vérifier l'invariant ADR-023 :

```
grossCollected - successfulRefunded - settledOffPlatform - refundStillOwed = solde comptable
```

### Invariant

L'invariant ADR-023 §11.2 est **obligatoire** et vérifié à chaque projection par `assertFinancialInvariant` :

```
grossCollectedAmountMinor
- successfulRefundedAmountMinor
- settledOffPlatformAmountMinor
- refundStillOwedAmountMinor
= contractualTotalAmountMinor
```

La comparaison utilise `BigInt` pour une précision exacte sans perte. Si le solde comptable diffère du total contractuel, `getEffectiveBooking` lève `EffectiveBookingError('FINANCIAL_INVARIANT_VIOLATION')` et ne retourne jamais une projection incohérente. Les montants individuels sont d'abord validés comme entiers sûrs non-négatifs (≤ `MAX_SAFE_INTEGER`).

### Sécurité des montants

- `normalizeAggregateAmount` valide que chaque montant agrégé est un entier sûr non-négatif (≤ `MAX_SAFE_INTEGER`).
- Les agrégations `SUM` PostgreSQL retournent `null` si aucune ligne — normalisé en `0`.
- Les colonnes `bigint` de drizzle-orm retournent `string` — converti en `number`.
- Toute incohérence persistée (non-entier, négatif, dépassement) → `EffectiveBookingError('SNAPSHOT_INVALID')` avec contexte.
- Aucune donnée provider exposée (pas de `provider_refund_id`, `provider_idempotency_key`, etc. dans la projection).

## Contexte de transaction

La fonction accepte `DbExecutor` (DatabaseClient ou DatabaseTransaction). Aucune transaction interne n'est créée — la projection est read-only et peut être appelée dans la transaction d'un appelant.

Un test PostgreSQL (test 31) prouve que l'appel depuis une transaction réelle compile et passe :

```typescript
const result = await db.transaction(async (tx) => {
  return getEffectiveBooking(tx, organizationId, bookingId);
});
```

## Exports publics

### Exposés depuis `@uttily/core`

- `getEffectiveBooking` (fonction)
- `EffectiveBookingError` (classe)
- `EffectiveBookingErrorCode` (type)
- `EffectiveBooking`, `EffectiveLine`, `EffectiveAllocation`, `EffectiveFinancials`, `AmendmentSummary`, `GetEffectiveBookingResult` (types)

### Non exposés depuis `@uttily/core`

- `parseFinancialSnapshot` (helper interne, exporté uniquement depuis `get-effective-booking.ts` pour les tests unitaires colocalisés)
- `normalizeAggregateAmount` (helper interne, exporté uniquement depuis `get-effective-booking.ts` pour les tests unitaires colocalisés)
- `assertFinancialInvariant` (helper interne, exporté uniquement depuis `get-effective-booking.ts` pour les tests unitaires colocalisés)
- `isEffectiveBookingErrorCode` (type guard, exporté uniquement depuis `errors.ts` pour les tests unitaires colocalisés)
- `FinancialSnapshot` (type interne, exporté uniquement depuis `types.ts`)
- Loaders internes (`loadOriginalLines`, `loadOriginalAllocations`, `loadAmendmentLines`, `loadAmendmentAllocations`, `loadFinancials`)
- Guards purement internes

### Code `UNKNOWN` supprimé

Le code `UNKNOWN` a été supprimé de `EffectiveBookingErrorCode`. Il n'était jamais produit par la projection et ne doit pas figurer dans l'API publique.

## Fichiers

### Créés

- `packages/core/src/booking-amendments/get-effective-booking.ts` — projection principale, parsing JSONB, projection financière
- `packages/core/src/booking-amendments/types.ts` — types publics (`EffectiveBooking`, `EffectiveLine`, `EffectiveAllocation`, `EffectiveFinancials`, `AmendmentSummary`, `FinancialSnapshot`, `GetEffectiveBookingResult`)
- `packages/core/src/booking-amendments/errors.ts` — `EffectiveBookingError`, `EffectiveBookingErrorCode`, `isEffectiveBookingErrorCode`
- `packages/core/src/booking-amendments/index.ts` — barrel exports (publics uniquement)
- `packages/core/src/booking-amendments/get-effective-booking.test.ts` — 46 tests unitaires
- `packages/core/src/booking-amendments/get-effective-booking.integration.test.ts` — 34 tests PostgreSQL
- `docs/implementation/g7m-b1-effective-booking.md` — ce document

### Modifiés

- `packages/core/src/index.ts` — export additif `export * from './booking-amendments'`
- `docs/implementation/backlog.md` — statut G7M-B1
- `docs/implementation/agent-context.md` — statut G7M-B1

## Tests

### Tests unitaires (46)

- `parseFinancialSnapshot` : snapshot correct, null, tableau, non-entier, négatif, >MAX_SAFE_INTEGER, currency manquante/vide/non-EUR, NaN, string, contexte
- `normalizeAggregateAmount` : null→0, entier sûr, zéro, non-entier, NaN, négatif, >MAX_SAFE_INTEGER, contexte
- `EffectiveBookingError` : code, message, instance de Error
- `getEffectiveBooking` validation UUID : organizationId invalide, bookingId invalide, les deux invalides
- `assertFinancialInvariant` : égalité exacte acceptée, égalité avec zéros acceptée, solde supérieur rejeté, solde inférieur rejeté, non-entier rejeté, >MAX_SAFE_INTEGER rejeté, négatif rejeté, pas de PII ni donnée provider dans le message
- Exports publics : `parseFinancialSnapshot` non exposé depuis barrel, `normalizeAggregateAmount` non exposé depuis barrel, `assertFinancialInvariant` non exposé depuis barrel, `isEffectiveBookingErrorCode` non exposé depuis barrel, `FinancialSnapshot` non exposé depuis barrel, `parseFinancialSnapshot`/`normalizeAggregateAmount`/`assertFinancialInvariant`/`isEffectiveBookingErrorCode` non exposés depuis `@uttily/core`, `getEffectiveBooking` exposé, `EffectiveBookingError` exposé, `UNKNOWN` pas dans les codes publics, `FINANCIAL_INVARIANT_VIOLATION` est un code valide

### Tests PostgreSQL (34)

1. booking sans amendement → projection originale
2. un amendement APPLIED → projection du snapshot après
3. plusieurs APPLIED → dernier amendment_number utilisé
4. HOLD_PENDING ignoré
5. READY_TO_APPLY ignoré
6. EXPIRED ignoré (via SUPPLEMENT → HOLD_PENDING → EXPIRED)
7. CANCELLED ignoré (via SUPPLEMENT → HOLD_PENDING → CANCELLED)
8. lignes REMOVE exclues
9. ADD/MODIFY/UNCHANGED projetées (deux variantes pour respecter la contrainte unique)
10. allocations CONVERTED incluses (avec release du block original + nouveau block)
11. allocations PROPOSED exclues
12. historique APPLIED ordonné (insertion dans l'ordre inverse pour vérifier le tri)
13. tenant isolation avec une deuxième organisation
14. booking inexistante et booking autre tenant → même NOT_FOUND
15. devise et montants préservés
16. timezone du lieu préservé
17. données JSONB persistées invalides → erreur Core typée
18. aucune écriture effectuée par la projection (vérification `updated_at` inchangé)
19. paiement initial SUCCEEDED inclus dans grossCollected
20. paiement initial non-SUCCEEDED exclu du grossCollected
21. amendment_payment SUCCEEDED inclus dans grossCollected
22. amendment_payment non-SUCCEEDED exclu du grossCollected
23. refund SUCCEEDED sur payment initial inclus
24. refund SUCCEEDED sur amendment_payment inclus
25. PENDING/SUBMITTED/FAILED_REQUIRES_MANUAL_ACTION comptés comme encore dus
26. SETTLED_OFF_PLATFORM compté séparément et pas comme encore dû
27. refunds des deux origines agrégés sans double comptage
28. plusieurs amendment_payments et refunds sans multiplication cartésienne
29. tenant B exclu des financials
30. invariant financier avec valeurs représentatives (grossCollected=15000, successfulRefunded=3000, settledOffPlatform=300, refundStillOwed=500, contractualTotal=11200, solde=contractualTotal)
31. appel réel depuis une transaction
32. logicalLineId original — allocation liée à la bonne ligne originale
33. logicalLineId amendé — allocation liée à la bonne ligne logique (deux lignes/variantes, deux allocations, pas de mélange)
34. invariant financier violé → rejet FINANCIAL_INVARIANT_VIOLATION (refund SUCCEEDED 2000 sur payment initial avec contractualTotal=10000 → solde=8000≠10000)

### Stratégie de test

- Base de test dédiée `uttily_test_g7m_b1` (pattern identique à `schema-g7m-a-amendments.test.ts`)
- Skip en local si `DATABASE_URL` absente ; échec explicite en CI
- Triggers réels de 0036 actifs (INSERT `READY_TO_APPLY` pour NEUTRAL/REFUND, INSERT `HOLD_PENDING` pour SUPPLEMENT avec transition `HOLD_PENDING → READY_TO_APPLY → APPLIED`, INSERT `PROPOSED` pour allocations avec transition `PROPOSED → CONVERTED/RELEASED`, INSERT `PENDING_PROVIDER` pour amendment_payments avec transition vers `SUCCEEDED/FAILED/CANCELLED`, immutabilité)
- Aucune désactivation de contrainte ou de trigger
- Suffixes uniques par test pour éviter les collisions de slug

## Vérifications

- Tests unitaires : 46 passed
- Tests PostgreSQL : 34 passed
- Suite Core complète : 2260 passed, 0 fail, 0 skip (durée ~1062s)
- `pnpm typecheck` : exit 0
- `pnpm lint` : exit 0
- `pnpm format:check` : exit 0
- `git diff --check` : exit 0

## G7M-B2 et G7M-C différés

### G7M-B2 (différé)

- `createAndApplyAmendment` pour NEUTRAL et REFUND avec application atomique immédiate
- Optimistic locking obligatoire : `expectedLastAppliedAmendmentNumber` dans la commande, rejet `STALE_EFFECTIVE_BOOKING` (HTTP 409) si la réservation a changé depuis son chargement
- Plafond cumulatif des remboursements incluant `SETTLED_OFF_PLATFORM`
- Routage du refund via l'exécuteur existant (`executeCompensation`) — événement outbox à router vers le worker refund déjà en place
- Fulfillment exclusion : refus si amendement `HOLD_PENDING`/`READY_TO_APPLY` actif

### G7M-C (différé)

- SUPPLEMENT complet (hold delta-segment, paiement Stripe, webhook, expiration, compensation)
- Route cliente `/checkout/amendment/[amendmentId]` (Stripe Elements)
- Webhooks `payment_intent.succeeded`/`payment_failed` pour `amendment_payments`
- Réconciliation `amendment_payment_attempts`
- Expiration cron + compensation tardive
- Documents amendés (pipeline outbox worker/parser)
- Migration fulfillment vers `getEffectiveBooking` (consommateurs §4.2)
- `create-condition-report`/`create-damage-report` sur `amendment_allocation_id`

## Gaps

None — l'invariant financier est vérifié à chaque projection avec preuves PostgreSQL réelles (34 tests, 0 skip).
