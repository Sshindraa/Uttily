# G7M-B2-A — Amendements neutres (createNeutralBookingAmendment)

## Périmètre

Implémentation du cas d'usage transactionnel `createNeutralBookingAmendment` :
création et application atomique d'un amendement **NEUTRAL** (delta financier nul)
sur une réservation `CONFIRMED`. Les types `REFUND` et `SUPPLEMENT` sont **différés**
à des lots ultérieurs (G7M-B2-B/C).

Statut : **Conforme & Vérifié** (Vannes de vérification exécutées avec succès).

## API

```typescript
export async function createNeutralBookingAmendment(
  db: DatabaseClient,
  authenticatedActor: AuthenticatedUser,
  organizationId: string,
  command: NeutralAmendmentCommand,
  options?: { now?: Date },
): Promise<NeutralAmendmentResult>
```

### Commande

- `bookingId` : UUID de la réservation à amender.
- `expectedLastAppliedAmendmentNumber` : optimistic locking (valeur lue via `getEffectiveBooking`).
- `intent` : intention tarifaire sémantique (`TIME_RANGE` avec dates locales ISO `startAt`/`endAt`, ou `DAY_RANGE` avec `startDate`/`endDateExclusive`).
- `desiredLines` : état cible complet (after). `logicalLineId` présent = ligne existante ; absent = nouvelle ligne (génère un nouveau `logicalLineId`).
- `idempotencyKey` : clé d'idempotence.

### Résultat (union fermée)

- `SUCCESS` : amendement créé et appliqué (`amendmentId`, `amendmentNumber`).
- `REPLAY` : clé idempotente déjà terminée, même empreinte (`amendmentId`, `amendmentNumber`).
- `NOT_FOUND` : réservation inexistante ou autre tenant (tenant-safe).
- `FORBIDDEN` : rôle insuffisant (OWNER/ADMIN/MANAGER requis).
- `BOOKING_NOT_CONFIRMED` : statut != CONFIRMED.
- `ACTIVE_AMENDMENT_EXISTS` : un amendement HOLD_PENDING ou READY_TO_APPLY existe.
- `STALE_EFFECTIVE_BOOKING` : expected != actual (concurrence).
- `INVALID_INPUT` : validation d'entrée ou de diff de lignes échouée.
- `AVAILABILITY_CONFLICT` : chevauchement d'inventaire / exclusion constraint.
- `FINANCIAL_ACTION_REQUIRED` : delta non-nul (`REFUND` ou `SUPPLEMENT` requis).
- `IDEMPOTENCY_CONFLICT` : même clé, empreinte différente.

## Transaction et ordre des verrous

ADR-023 §12 :

1. `lockOrganization(tx, organizationId)` — verrou advisory par organisation.
2. `lockKey(tx, recordId)` — verrou sur la ligne idempotency_records.
3. `bookings` filtré par `getEffectiveBooking` (tenant-safe).
4. `booking_amendments` — vérification d'amendement actif.
5. `inventory_blocks` — `FOR UPDATE ORDER BY id` (déterministe, pas de deadlock).

La logique métier s'exécute dans une transaction PostgreSQL isolée.
En cas d'échec métier déterministe, `failKey` est appelé dans la transaction externe, et le résultat métier est retourné. En cas d'erreur inattendue, la transaction entière est annulée.

## Idempotence et optimistic locking

- **Empreinte** : SHA-256 d'un JSON canonique (`v: 'amendment-neutral-v2'`), indépendant de l'ordre des champs. Inclus l'intention tarifaire sémantique complète et les `desiredLines` triées par `variantId` puis `logicalLineId`.
- **reserveKey** : avant la transaction. REPLAY → retour du résultat persisté (`{ kind: 'REPLAY', ... }`). CONFLICT → IDEMPOTENCY_CONFLICT.
- **Optimistic locking** : sous les verrous, `expectedLastAppliedAmendmentNumber` est comparé à `lastAppliedAmendmentNumber`. Mismatch → STALE_EFFECTIVE_BOOKING.

## Pricing autoritatif et disponibilité

- Tarification autoritative via le moteur G7P `quoteFlexiblePricing` (plans `ACTIVE` en base, fenêtres et tarification DAILY/HOURLY/FIXED_DURATION).
- Dates client et dates bloquées calculées selon `intent` (`TIME_RANGE` ou `DAY_RANGE`) et buffers de lieu.
- Le delta = `after.totalAmountMinor - before.totalAmountMinor`. Si delta != 0, le résultat est `FINANCIAL_ACTION_REQUIRED` (aucune écriture).
- Pour les nouveaux items (ADD), une sélection d'exemplaires disponibles par verrouillage déterministe exclut les chevauchements avec d'autres réservations. La violation de contrainte d'exclusion `23P01` (`no_overlapping_blocks`) est capturée et mappée vers `AVAILABILITY_CONFLICT`.

## Filiation et snapshots des lignes

- `originType` (`ORIGINAL` | `AMENDMENT`) et `sourceBookingLineId` (identifiant de la ligne `booking_lines` d'origine ou `null` pour une ligne créée par amendement) sont préservés à travers les amendements successifs.
- Snapshots complets G7P persistés dans `booking_amendment_lines.pricingSnapshot` (`algorithmVersion`, `roundingRuleVersion`, `resolvedLocale`, `intentSnapshot`, `planId`, `planVersion`, `planType`, `publicLabel`, `billedDays`, etc.).

## Application append-only

- **Aucune mutation** de `bookings`, `booking_lines`, `booking_items` ou des snapshots originaux.
- `booking_amendments` : INSERT en `READY_TO_APPLY`, puis UPDATE → `APPLIED` avec `applied_at`.
- `booking_amendment_lines` : INSERT-only (trigger bloque UPDATE/DELETE). Actions ADD/MODIFY/REMOVE/UNCHANGED avec before/after quantities, prices, originType, et pricingSnapshot.
- `booking_amendment_allocations` : INSERT en `PROPOSED`, puis UPDATE vers `CONVERTED` (avec `applied_booking_block_id`) ou `RELEASED`.
- `inventory_blocks` : les anciens blocks sont `RELEASED`, les nouveaux sont `ACTIVE` (type `BOOKING`, `source_id` = bookingId).

## Outbox BOOKING_AMENDED.v1

- Insertion dans `outbox_events` avec les constantes fermées de `@uttily/contracts` (`BOOKING_AMENDED_AGGREGATE_TYPE`, `BOOKING_AMENDED_EVENT_TYPE`, `BOOKING_AMENDED_EVENT_VERSION`).
- Validé par le parseur runtime fermé `parseBookingAmendedV1Event(input)`.

## Concurrence et Robustesse

- **Concurrence de disponibilité** : validée avec 2 connexions simultanées en compétition sur le dernier exemplaire (exactement 1 SUCCESS, 1 AVAILABILITY_CONFLICT).
- **Test de Deadlock** : validé avec >= 3 connexions réelles concurrentes sans aucun deadlock PostgreSQL (`40P01`).
- **Rollback tardif** : validé avec injection de trigger PostgreSQL sur `outbox_events` démontrant l'annulation atomique totale de la transaction.

## Différé

- `REFUND` : amendement avec delta négatif (remboursement Stripe).
- `SUPPLEMENT` : amendement avec delta positif (paiement Stripe supplément).

## Rapport de Vérification Finale (Livraison G7M-B2-A)

- **Contracts** : 3 fichiers, 20 tests (passés).
- **Unit B2-A** : 1 fichier (`create-neutral-booking-amendment.test.ts`), 37 tests (passés).
- **PostgreSQL B2-A** : 1 fichier (`create-neutral-booking-amendment.integration.test.ts`), 13 tests, 0 skip (passés).
- **Suite booking-amendments** : 2 fichiers, 50 tests, 0 skip (passés).
- **Suite pricing-plans** : 3 fichiers, 56 tests, 0 skip (passés).
- **Suite Core complète (preuve pré-finition conservée)** : 88 fichiers, 2310 tests, 0 échec, 0 skip, durée 1234.29 s (20m34s). *Note : La dernière passe de finition ne touche que les fixtures de test, le barrel d'exports de types (`NeutralAmendmentIntent`) et la documentation ; la preuve globale Core est donc conservée.*
- **Outillage & Qualité** : `pnpm lint`, `pnpm typecheck`, `pnpm exec prettier --check` (sur les 15 fichiers G7M-B2-A) et `git diff --check` sont 100% conformes.
- **Avertissement Moteur Node** : Avertissement de compatibilité mineur de pnpm (`wanted: {"node": ">=24"}` vs `current: {"node": "v22.23.1"}`). Sans impact.

### Description des tests d'intégration PostgreSQL clés

- **Concurrence de disponibilité (Test 9)** : 2 réservations distinctes dans la même organisation disputant le dernier exemplaire libre de la variante 2 lors d'un swap neutre simultané. Exactement 1 `SUCCESS` et 1 `AVAILABILITY_CONFLICT` dans `Promise.allSettled`. Le gagnant possède 1 amendement `APPLIED`, le perdant possède 0 enregistrement d'amendement.
- **Test de Deadlock borné (Test 10)** : 3 connexions DB indépendantes exécutant des amendements neutres concurrents sur la même organisation sous `Promise.allSettled` avec un timeout strict de 30 secondes et `clearTimeout` en clause `finally`. Inspection récursive de toute la chaîne de causes garantissant l'absence de code SQLSTATE `40P01`.

### Fichiers modifiés et créés (15 fichiers au total)

Modifiés (8) :
- `docs/implementation/agent-context.md`
- `docs/implementation/backlog.md`
- `packages/contracts/src/index.ts`
- `packages/core/src/booking-amendments/get-effective-booking.ts`
- `packages/core/src/booking-amendments/index.ts`
- `packages/core/src/booking-amendments/types.ts`
- `packages/core/src/pricing-plans/load-pricing-context.ts`
- `packages/core/src/pricing-plans/quote-flexible-pricing.ts`

Nouveaux / Untracked (7) :
- `docs/implementation/g7m-b2a-neutral-amendments.md`
- `packages/contracts/src/booking-amended-event.test.ts`
- `packages/contracts/src/booking-amended-event.ts`
- `packages/core/src/booking-amendments/create-neutral-booking-amendment.integration.test.ts`
- `packages/core/src/booking-amendments/create-neutral-booking-amendment.test.ts`
- `packages/core/src/booking-amendments/create-neutral-booking-amendment.ts`
- `packages/core/src/booking-amendments/types-amendment.ts`

Aucun fichier de migration, schéma, journal Drizzle, `package.json`, lockfile ou code hors périmètre n'a été altéré.
