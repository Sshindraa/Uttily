# G7M-C4-A — Orchestration du lifecycle des suppléments (expiration, retry N+1, réconciliation)

## Statut

G7M-C4-A est livré dans Core (`packages/core/src/booking-amendments/`).
C1 à C4-A sont validés par leurs suites dédiées ; C4-B (compensation et
wiring), C5 (UI) et la validation globale ont été livrés et validés dans les
jalons suivants et la CI post-merge.

Cette phase ne livre aucun worker, cron, webhook, route, UI, migration de
données, compensation automatique ou wiring d'orchestration externe.

## Périmètre & Architecture

G7M-C4-A fournit l'orchestration métier complète du cycle de vie des
suppléments financiers :

### 1. Expiration (`expireSupplementAmendmentsBatch`)
- Sélectionne de manière atomique et bornée (`FOR UPDATE SKIP LOCKED`) uniquement :
  - les amendements de type `SUPPLEMENT` ;
  - au statut `HOLD_PENDING` ou `READY_TO_APPLY` ;
  - dont `hold_deadline <= asOf`.
  (La sélection ne dépend pas de `reconcile_after`).
- Filtre optionnel par organisation (`organizationId`).
- Passe atomiquement en statut `EXPIRED` dans une seule transaction :
  - les `inventory_blocks` de type `HOLD` encore `ACTIVE` ou `PAYMENT_PROCESSING` ;
  - les `booking_amendment_segments` au statut `PROPOSED` ;
  - les `booking_amendment_allocations` au statut `PROPOSED` ;
  - le `booking_amendment`.
- Insère de façon idempotente l'événement d'outbox `BOOKING_AMENDMENT_EXPIRED.v1`
  (`aggregateType: 'BOOKING'`, `aggregateId: bookingId`, `organizationId`).

### 2. Retry N+1 (`retryFailedSupplementPayment`)
- Exige un amendement de type `SUPPLEMENT` actif (`HOLD_PENDING` ou `READY_TO_APPLY`)
  strictement avant sa borne temporelle (`now < holdDeadline`, sinon `HOLD_EXPIRED`).
- Exige un `amendment_payment` au statut `FAILED` (sinon `NOT_RETRYABLE`).
- Vérifie qu'aucun attempt actif ou non terminal (`PENDING_PROVIDER`,
  `REQUIRES_PAYMENT_METHOD`, `REQUIRES_ACTION`, `PROCESSING`) n'existe.
- Crée l'attempt N+1 au statut `PENDING_PROVIDER` avec la clé d'idempotence stable
  `pi_amendment_${payment.id}_${attemptNumber}`, vierge de données provider.
- Remet uniquement `amendment_payment` au statut `PENDING_PROVIDER` (remet à null
  `succeededAt`, `failedAt`, `cancelledAt`, `processingStartedAt`, `processingDeadlineAt`).
- **Ne remet jamais** le `booking_amendment` en `HOLD_PENDING` (l'amendement
  conserve son statut actif).
- Garantit l'isolation stricte par organisation (`organizationId`).

### 3. Réconciliation (`reconcileSupplementPaymentsBatch`)
- Traite les attempts aux statuts : `PENDING_PROVIDER`, `REQUIRES_PAYMENT_METHOD`,
  `REQUIRES_ACTION`, `PROCESSING` dont `reconcile_after <= claimAsOf` et dont
  `reconcile_lease_until` est `NULL` ou expiré.
- Sélectionne les attempts éligibles avec le pattern `FOR UPDATE OF apa SKIP LOCKED`
  et leur affecte un lease token (`reconcile_lease_token`) ainsi qu'une échéance
  (`reconcile_lease_until`).
- Exécute les appels provider Stripe (`createPaymentIntent` ou `retrievePaymentIntent`)
  **hors transaction et hors verrou DB**.
- **Horloge fraîche (`providerCallAt`)** : avant chaque appel provider, une courte
  phase PostgreSQL séparée vérifie la validité du lease token et capture l'horloge
  fraîche `providerCallAt`. Pour `createPaymentIntent`, la condition stricte est :
  `providerCallAt < holdDeadline`. Si la deadline est franchie après le claim mais
  avant l'appel provider, la création est ignorée (`skippedExpiredCount++`) et le
  lease est libéré sans appel provider. `retrievePaymentIntent` reste autorisé
  après deadline si le lease est valide.
- **Libérations de lease protégées** : les libérations de lease (`reconcile_lease_until: null`,
  `reconcile_lease_token: null`) sont conditionnelles et protégées par la
  vérification du lease token (`WHERE reconcile_lease_token = claimed.leaseToken`).
- **Autorité webhook** : un résultat provider `succeeded` ne finalise pas
  localement le paiement en `SUCCEEDED` ni n'applique l'amendement. Le webhook C3
  reste l'autorité du succès et de l'application. La réconciliation persiste
  uniquement les champs provider nécessaires (`provider_payment_intent_id`,
  `provider_status`).
- **Union fermée des anomalies** :
  - `LEASE_LOST`
  - `PROVIDER_ENVIRONMENT_MISMATCH`
  - `PROVIDER_RESULT_INVALID`
  - `PROVIDER_ID_MISMATCH`
  - `TENANT_INVARIANT_VIOLATION`
  - `PROVIDER_CALL_FAILED`
  - `INVARIANT_BROKEN`

### 4. Isolation multi-organisation
- Toutes les requêtes et jointures sont strictement filtrées par organisation (`organization_id`).
- `retryFailedSupplementPayment` verrouille explicitement l'organisation via `lockOrganization`.
- La phase de projection de la réconciliation (`applyProviderProjection`) verrouille explicitement l'organisation via `lockOrganization`.
- `expireSupplementAmendmentsBatch` filtre optionnellement par `organizationId` à la sélection puis maintient le scope `organization_id` sur l'ensemble de ses lectures et mutations.
- `claimSupplementPaymentBatch` garantit la cohérence organisationnelle dans toutes ses jointures SQL et reste interne au module (non exporté par le barrel public).

## API Publique

Le module `packages/core/src/booking-amendments/index.ts` exporte les fonctions
lifecycle suivantes :

- `expireSupplementAmendmentsBatch`
- `retryFailedSupplementPayment`
- `reconcileSupplementPaymentsBatch`

## Preuves & Validation

- **17/17 tests PostgreSQL réels** : exécutés et validés dans
  `packages/core/src/booking-amendments/supplement-lifecycle.integration.test.ts`
  (incluant l'expiration atomique, le retry N+1, la course de deadline avec
  marge CI robuste, la réconciliation Stripe et la détection de `LEASE_LOST`).
- **230/230 tests du module `booking-amendments`** : 14 suites unitaires et
  d'intégration réelles couvrant l'ensemble du module Core de C1 à C4-A à 100%
  sans régression. (La suite C4-S est une suite database distincte de 9 tests).
- **Validation Core globale** : validée depuis dans la CI post-merge ; ce rapport
  conserve la preuve ciblée du jalon C4-A.

## Périmètre exclu au jalon C4-A

- C4-B et C5 étaient exclus de ce jalon et sont documentés dans leurs rapports
  de livraison respectifs.
