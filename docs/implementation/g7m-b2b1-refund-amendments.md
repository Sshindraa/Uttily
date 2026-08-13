# G7M-B2-B1 — Amendements financiers de type REFUND (createRefundBookingAmendment)

## Périmètre

Implémentation du lot **G7M-B2-B1** : création transactionnelle d'un amendement financier de type **REFUND** avant pickup sur une réservation `CONFIRMED`.

Dans ce lot (livré en B2-B1) :
- `createRefundBookingAmendment` valide que le nouveau total contractuel est strictement inférieur à l'ancien (`delta < 0`).
- L'amendement est créé en `READY_TO_APPLY` puis appliqué (`APPLIED`) dans la même transaction atomique PostgreSQL (fondations de schéma de la migration `0036_g7m_a_amendment_schema.sql`).
- Les allocations physiques sont mises à jour selon le diff de lignes et d'inventaire.
- Une ligne `refunds` est créée au statut `PENDING` avec motif `BOOKING_MODIFICATION`, `amount_minor` = `|delta|`, et `provider_idempotency_key` = `refund_amendment_${refundId}`. Le remboursement reste en `PENDING` dans DB, le paiement initial reste `SUCCEEDED`, et aucun provider Stripe n'est appelé à l'étape B2-B1 (le consumer worker Stripe fera l'objet du lot G7M-B2-B2).
- Les événements `BOOKING_AMENDED.v1` et `REFUND_REQUESTED.v1` sont publiés dans `outbox_events` dans la même transaction.
- En cas d'échec lors du commit métier/outbox, la transaction PostgreSQL annule tous les effets métier et outbox, tandis que l'enregistrement de réservation de clé idempotente conserve le statut `PENDING` jusqu'à son expiration.

Statut : **G7M-B2-B1 livré ; moteur Core G7M-B2-B2A livré et validé dans
`docs/implementation/g7m-b2b2a-refund-execution.md` ; wiring route/cron
G7M-B2-B2B livré dans `docs/implementation/g7m-b2b2b-refund-cron.md`**.

## API Publique `@uttily/core`

```typescript
export async function createRefundBookingAmendment(
  db: DatabaseClient,
  authenticatedActor: AuthenticatedUser,
  organizationId: string,
  command: RefundAmendmentCommand,
  options?: { now?: Date },
): Promise<RefundAmendmentResult>
```

### Types et Union Fermée (`RefundAmendmentResult`)

- `SUCCESS` : `{ kind: 'SUCCESS', amendmentId: string, amendmentNumber: number, refundId: string, refundAmountMinor: number }`
- `REPLAY` : `{ kind: 'REPLAY', amendmentId: string, amendmentNumber: number, refundId: string, refundAmountMinor: number }`
- `NOT_FOUND` : Réservation inexistante ou appartenant à un autre tenant.
- `FORBIDDEN` : Rôle insuffisant (OWNER/ADMIN/MANAGER requis).
- `BOOKING_NOT_CONFIRMED` : Statut != CONFIRMED.
- `ACTIVE_AMENDMENT_EXISTS` : Amendement actif existant.
- `STALE_EFFECTIVE_BOOKING` : Optimistic locking mismatch (`expected` vs `actual`).
- `INVALID_INPUT` : Entrées invalides ou dépassement du cap cumulatif du paiement initial.
- `AVAILABILITY_CONFLICT` : Stock insuffisant / chevauchement d'inventaire.
- `FINANCIAL_ACTION_REQUIRED` : Delta neutre (`NEUTRAL`) ou positif (`SUPPLEMENT`).
- `IDEMPOTENCY_CONFLICT` : Même clé idempotente avec une empreinte différente.

## Refactor Interne du Moteur

Extrait dans `packages/core/src/booking-amendments/execute-booking-amendment-internal.ts` :
- `createNeutralBookingAmendment` et `createRefundBookingAmendment` sont des wrappers fins autour du moteur unifié.
- Mode classification fermé : `'NEUTRAL'` | `'REFUND'`.
- Ordre de verrouillage strict pour prévenir tout deadlock : `bookings` `FOR UPDATE` par `bookingId`, puis `inventory_blocks` par `id` croissant `FOR UPDATE`.

## Contrat Outbox `REFUND_REQUESTED.v1` (`@uttily/contracts`)

Fichier : `packages/contracts/src/refund-requested-event.ts`
- `aggregateType`: `'REFUND'`
- `eventType`: `'REFUND_REQUESTED'`
- `eventVersion`: `'v1'` strictly
- `aggregateId`: `refundId`
- `payload` minimal (4 UUIDs uniquement) : `{ organizationId, bookingId, amendmentId, refundId }`.
- Parseur strict `parseRefundRequestedV1Event(input)`.

## Idempotence et Clés Outbox

- **Operation Idempotency** : `booking-amendment-refund`
- **Fingerprint Version** : `amendment-refund-v1`
- **Clé provider refund** : `refund_amendment_${refundId}`
- **Clé outbox REFUND_REQUESTED** : `refund_requested_${refundId}` (distincte de la clé provider)
- **Clé outbox BOOKING_AMENDED** : `booking_amended_${amendmentId}` (préservée exacte)

## Bounding Cumulatif et Concurrence

Avant la création de la ligne `refunds` :
1. Verrouillage de la ligne du paiement initial : `SELECT ... FOR UPDATE` sur `payments`.
2. Calcul du cumul des remboursements existants sur ce `payment_id` pour les statuts `PENDING`, `SUBMITTED`, `SUCCEEDED`, `FAILED_REQUIRES_MANUAL_ACTION`, `SETTLED_OFF_PLATFORM`. Le statut legacy `FAILED` est exclu.
3. Invariant : `cumulativeCountedRefunds + refundAmountMinor <= payment.amountMinor`.
4. En cas de dépassement, retour immédiat de `{ kind: 'INVALID_INPUT', message: '...' }` (fail-closed).

## Invariant Financier et `getEffectiveBooking`

Après commit et avant traitement provider (statut `PENDING`) :
- `contractualTotalAmountMinor` est réduit au nouveau total.
- `refundStillOwedAmountMinor` est augmenté de `amountMinor`.
- L'équation ADR-023 §11.2 est strictement respectée :
  $$\text{grossCollected} - \text{successfulRefunded} - \text{settledOffPlatform} - \text{refundStillOwed} = \text{contractualTotal}$$

## Rapport de Vérification

- **Contracts** : 4 fichiers, 29 tests (passés).
- **Unit booking-amendments** : 2 fichiers (`create-neutral-booking-amendment.test.ts`, `create-refund-booking-amendment.test.ts`), 50 tests (passés).
- **PostgreSQL booking-amendments** : 2 fichiers (`create-neutral-booking-amendment.integration.test.ts`, `create-refund-booking-amendment.integration.test.ts`), 23 tests, 0 skip (passés).
- **Module booking-amendments** : 6 fichiers, 153 tests, 0 skip (passés).
- **Suite Core complète** : la commande `DATABASE_URL=postgres://uttily:uttily@127.0.0.1:5432/uttily pnpm --filter @uttily/core exec vitest run --no-file-parallelism` s'est terminée avec exit 0. Le résumé numérique terminal a été tronqué par le runner et n'est donc pas affirmé ici ; la CI fournira la preuve terminale complète après push.
- **Qualité & Gates** : `pnpm lint`, `pnpm typecheck`, `pnpm format:check` et `git diff --check` sont 100% conformes.
