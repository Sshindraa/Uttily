# G7M-C4-B — Compensation Atomique des Suppléments & Câblage Opérationnel

## Statut
**COMPLÉTÉ ET DURCI** — Conforme à 100% aux spécifications G7M-C4-B, ADR-023 §10.2, §11.2, §11.4 et aux règles architecturales du projet Uttily. C4-S et C4-A sont committés localement dans la pile ; C4-B est implémenté et validé dans le worktree (non commité) ; rien de C2–C4 n'est encore fusionné sur main. C5 reste pending et Core global reste pending CI.

- Use Case interne durci `compensateAmendmentPayment` (non exporté dans le barrel public `@uttily/core`).
- Éligibilité stricte : refus de toute compensation anticipée avant la `holdDeadline` ou sur amendement `APPLIED`. Horloge unique capturée de manière finite.
- Rejeu strict du refund et de l'outbox associé via validation fermée `parseRefundRequestedV1Event` (rejet de toute propriété payload supplémentaire, métadonnée racine incompatible, ou aggregateId divergent).
- Validation autoritative fail-closed dans `verifyRefundRequest` (zéro appel provider externe en cas de divergence d'agrégat, d'organisation, de montant, de devise, de flags, de clé provider, de statut ou d'environnement).
- Appel provider `createRefund` prouvé **HORS transaction** par lock probe PostgreSQL réel concurrent `SELECT ... FOR UPDATE NOWAIT` sur 5 tables (`outbox_events`, `refunds`, `amendment_payments`, `booking_amendments`, `amendment_payment_attempts`).
- Sémantique d'échec webhook : rollback total, retour HTTP 500 en cas de panne technique DB/outbox, aucun refund orphelin, aucun paiement projeté `SUCCEEDED` prématurément, aucun log brut de secret, de message PostgreSQL simulé ou de payload non assaini.
- Routes Web Cron existantes `apps/web/src/app/api/cron/expire-holds/` et `apps/web/src/app/api/cron/reconcile-payments/` câblées pour exécuter les batchs de suppléments C4-A sans modifier `vercel.json`.
- Preuves dédiées :
  - **26 / 26 tests d'intégration PostgreSQL réels** dans `packages/core/src/booking-amendments/supplement-compensation.integration.test.ts`.
  - **26 / 26 tests d'intégration PostgreSQL réels** dans `packages/core/src/refund-request-execution/refund-request-execution.integration.test.ts`.
  - **105 / 105 tests d'intégration PostgreSQL réels** dans `handle-webhook.integration.test.ts` et `apply-supplement-amendment.integration.test.ts`.
  - **11 / 11 tests d'intégration PostgreSQL réels** dans `apps/web/src/app/api/cron/expire-holds/route.test.ts`.
  - **9 / 9 tests d'intégration PostgreSQL réels** dans `apps/web/src/app/api/cron/reconcile-payments/route.test.ts`.
- Régressions validées à 100% :
  - `booking-amendments` : **15 suites, 256 / 256 tests passés (0 échec, 0 skip)**.
  - `pnpm run typecheck` : 0 erreur TypeScript sur l'ensemble du monorepo (8 packages / applications).
  - `pnpm run lint` : 0 avertissement, 0 erreur.
  - `pnpm --filter @uttily/web build` : compilation Next.js réussie avec succès.
  - `git diff --check` : 0 erreur d'espace ou de formatage.

Aucune migration de schéma, aucun changement schema.ts, aucun package/lockfile modifié, aucun nouveau cron Vercel, aucune UI ajoutée.

---

## Périmètre & Architecture

G7M-C4-B finalise l'orchestration financière et opérationnelle du cycle de vie des suppléments :

### 1. Use Case interne `compensateAmendmentPayment`
- Helper interne colocalisé, non exposé dans `packages/core/src/booking-amendments/index.ts`.
- Reçoit un client de transaction `DatabaseTransaction` et une entrée stricte :
  `{ organizationId, bookingId, amendmentId, amendmentPaymentId, now? }`.
- Respecte l'ordre canonique des verrous ADR-023 §3.3 / §12.1 :
  1. `lockOrganization(tx, organizationId)`
  2. `SELECT bookings FOR UPDATE`
  3. `SELECT booking_amendments FOR UPDATE`
  4. `SELECT amendment_payments FOR UPDATE`
- **Éligibilité stricte** :
  - Refuse catégoriquement un amendement dont le statut est `APPLIED`.
  - Refuse un amendement actif avant sa deadline (`holdDeadline !== null && now < holdDeadline`).
  - Capture l'horloge `now` une seule fois de manière finite (`nowOverride` ou `transaction_timestamp()`).
  - Valide que le type d'amendement est `SUPPLEMENT`.
- **Rejeu strict refund + outbox** :
  - Détecte tout état corrompu (ex. plusieurs refunds de compensation pour le même paiement).
  - En présence d'un refund existant :
    - Vérifie la conformité totale du tuple : `reason === 'AMENDMENT_COMPENSATION'`, `paymentId === null`, `amountMinor === amendmentPayment.amountMinor`, `currency === amendmentPayment.currency`, `reverseTransfer === true`, `refundApplicationFee === true`, `providerIdempotencyKey === 'refund_amendment_' + refund.id`.
    - Vérifie l'existence et la conformité stricte de l'outbox associé via `parseRefundRequestedV1Event` (`organizationId`, `aggregateType === 'REFUND'`, `aggregateId === refund.id`, `eventType === 'REFUND_REQUESTED'`, `eventVersion === 'v1'`, `idempotencyKey === 'refund_requested_' + refund.id`, et payload fermé exact `{ organizationId, bookingId, amendmentId, refundId }`).
    - En cas de discordance (propriété payload supplémentaire, outbox manquant, payload altéré, montant divergent), lève une exception fail-closed.
    - Si le tuple complet est cohérent, retourne `{ kind: 'ALREADY_COMPENSATED', refundId, amountMinor }`.
- **Création atomique** :
  - Insère dans `refunds` :
    - `payment_id = null`
    - `amendment_payment_id = amendmentPaymentId`
    - `reason = 'AMENDMENT_COMPENSATION'`
    - `status = 'PENDING'`
    - `amount_minor = amendmentPayment.amountMinor`
    - `currency = amendmentPayment.currency`
    - `reverse_transfer = true`
    - `refund_application_fee = true`
    - `provider_idempotency_key = 'refund_amendment_' + refundId`
  - Insère dans `outbox_events` :
    - `aggregate_type = 'REFUND'`
    - `aggregate_id = refundId`
    - `event_type = 'REFUND_REQUESTED'`
    - `event_version = 'v1'`
    - `idempotency_key = 'refund_requested_' + refundId`
    - `payload = { organizationId, bookingId, amendmentId, refundId }`
- Retourne `{ kind: 'COMPENSATION_CREATED', refundId, outboxEventId, amountMinor }`.

### 2. Câblage du Webhook C3 (`handleSupplementPaymentWebhook`)
- Dans `packages/core/src/booking-amendments/apply-supplement-amendment.ts`, lorsque `applySupplement` détecte un succès tardif (ex. `amendment.status = 'EXPIRED'` ou `holdDeadline <= asOf`) et retourne `LATE_SUCCESS_REQUIRES_COMPENSATION` :
  - Dans la même transaction et le même savepoint `sp` où la projection financière du paiement est enregistrée (`SUCCEEDED`) :
    - Invoque `compensateAmendmentPayment(sp, { ... })`.
    - Enregistre le log structuré d'événement `result: 'LATE_SUCCESS_REQUIRES_COMPENSATION'`.
  - En cas de défaillance technique transitoire (ex. erreur DB sur insertion outbox/refund) :
    - Rollback complet de la transaction.
    - Aucun refund partiel, le paiement et la tentative ne sont pas projetés `SUCCEEDED`.
    - L'événement webhook retourne HTTP 500 pour permettre le retry Stripe.
    - Assainissement strict des logs : le message technique brut, les UUIDs et les payloads ne sont jamais exposés dans les logs JSON structurés.

### 3. Extension et Validation Autoritative du Moteur Refund (`refund-request-execution`)
- `claim-refund-request-batch.ts` :
  - `LEFT JOIN amendment_payments ap ON ap.id = r.amendment_payment_id`.
  - Filtre d'environnement : `(r.payment_id IS NOT NULL AND p.environment = ${environment}) OR (r.amendment_payment_id IS NOT NULL AND ap.environment = ${environment})`.
- `execute-refund-request.ts` (`verifyRefundRequest`) :
  - Vérifie avant tout appel provider :
    - Refund et `amendmentPayment` dans la même organisation.
    - `amendmentPayment.amendmentId === authoritativeEvent.payload.amendmentId` et `amendmentPayment.bookingId === authoritativeEvent.payload.bookingId`.
    - Statut `amendmentPayment.status === 'SUCCEEDED'`.
    - `refund.amountMinor === amendmentPayment.amountMinor` et `refund.currency === amendmentPayment.currency === 'EUR'`.
    - `amendmentPayment.environment === environment`.
    - Amendement `SUPPLEMENT`, même organisation et même réservation.
    - Amendement non APPLIED et réellement tardif/expiré (`status === 'EXPIRED' | 'CANCELLED'` ou `now >= holdDeadline`).
    - Tentative `SUCCEEDED` appartenant exactement au paiement et à l'organisation avec `providerPaymentIntentId` présent.
    - Clé provider `providerIdempotencyKey === 'refund_amendment_' + refund.id` et flags `reverseTransfer === true`, `refundApplicationFee === true`.
  - Toute incohérence lève `RefundRequestError` de manière fail-closed sans appel provider.
- Appel provider hors transaction :
  - Prouvé formellement par lock probe PostgreSQL concurrent avec `SELECT ... FOR UPDATE NOWAIT` pendant `createRefund`.

### 4. Câblage des Crons Web Existants
- `apps/web/src/app/api/cron/expire-holds/route.ts` :
  - Exécute séquentiellement `expireBookingDraftsBatch` et `expireSupplementAmendmentsBatch`.
  - Retourne les métriques combinées `{ ok: true, supplements: { processedCount, expiredCount } }`.
- `apps/web/src/app/api/cron/reconcile-payments/route.ts` :
  - Exécute séquentiellement `reconcilePaymentsBatch` et `reconcileSupplementPaymentsBatch`.
  - Retourne les métriques combinées `{ ok: true, supplements: { ... } }`.
- `vercel.json` : conserve strictement les 4 routes déclarées existantes.

---

## Validation des Invariants Financiers (ADR-023 §11.2 & §11.4)

Lors d'un succès tardif avec compensation :
- `grossCollectedAmountMinor` augmente du montant du supplément (`amendment_payments` SUCCEEDED).
- `refundStillOwedAmountMinor` augmente du même montant (`refunds` PENDING avec `reason = 'AMENDMENT_COMPENSATION'`).
- `contractualTotalAmountMinor` reste au montant initial (l'amendement n'a jamais été appliqué).
- L'invariant `contractualTotalAmountMinor === grossCollectedAmountMinor - refundStillOwedAmountMinor - successfulRefundedAmountMinor` est garanti et validé par la fonction canonique `getEffectiveBooking(db, organizationId, bookingId)`.

---

## Preuves & Résultats de Test

### 1. Tests d'Intégration Core C4-B (`supplement-compensation.integration.test.ts`)
- **26 / 26 tests passés avec succès sur PostgreSQL réel** :
  1. `1.1 rejet explicite si l’amendement est actif avant sa deadline`
  2. `1.2 rejet explicite si l’amendement est APPLIED`
  3. `1.3 succès si l’amendement est EXPIRED ou passé sa deadline`
  4. `2.1 refund existant sans outbox associé → rejet explicite`
  5. `2.2 outbox existant avec payload incompatible → rejet explicite`
  6. `2.3 refund existant avec montant ou flags incompatibles → rejet explicite`
  7. `2.4 rejeu sur outbox contenant un champ supplémentaire → rejet explicite par contrat fermé`
  8. `2.5 rejeu strict parfait → retourne ALREADY_COMPENSATED`
  9. `3.1 mismatch organisation entre refund et payload → rejet worker sans appel provider`
  10. `3.2 table-driven fail-closed : 'montant refund !== amendmentPayment' → rejet fail-closed sans projection locale indue (0 appel provider)`
  11. `3.2 table-driven fail-closed : 'refund.currency = USD vs payment.currency = EUR avant provider' → rejet fail-closed sans projection locale indue (PAYMENT_CURRENCY_MISMATCH, 0 appel provider)`
  12. `3.2 table-driven fail-closed : 'reverseTransfer = false' → rejet fail-closed sans projection locale indue (0 appel provider)`
  13. `3.2 table-driven fail-closed : 'refundApplicationFee = false' → rejet fail-closed sans projection locale indue (0 appel provider)`
  14. `3.2 table-driven fail-closed : 'providerIdempotencyKey incorrecte' → rejet fail-closed sans projection locale indue (0 appel provider)`
  15. `3.2 table-driven fail-closed : 'payload avec un autre bookingId' → rejet fail-closed sans projection locale indue (0 appel provider)`
  16. `3.2 table-driven fail-closed : 'payload avec un autre amendmentId' → rejet fail-closed sans projection locale indue (0 appel provider)`
  17. `3.2 table-driven fail-closed : 'environnement LIVE alors que worker est TEST' → rejet fail-closed sans projection locale indue (0 appel provider)`
  18. `3.2 table-driven fail-closed : 'résultat provider avec devise non-EUR' → rejet fail-closed sans projection locale indue (PROVIDER_RESULT_INVALID, 1 appel provider, aucune projection locale SUBMITTED/PROCESSED)`
  19. `3.3 amendement APPLIED dans le worker → rejet sans appel provider`
  20. `4.1 panne outbox lors du webhook : retourne HTTP 500, rollback complet et logs assainis sans fuite technique`
  21. `5.1 prouve par lock probe PostgreSQL l’absence totale de verrous de transaction pendant l’appel provider createRefund`
  22. `6.1 concurrence réelle : deux compensations simultanées produisent exactement 1 refund et 1 outbox`
  23. `7.1 webhook à holdDeadline exactement crée atomiquement la compensation`
  24. `7.2 webhook replay est strictement idempotent (HTTP 200, zéro doublon)`
  25. `7.3 vérifie l’invariant financier ADR-023 §11.2 après compensation tardive via getEffectiveBooking`
  26. `7.4 passage réel de REFUND_REQUESTED.v1 jusqu’au moteur refund existant`

### 2. Tests d'Intégration du Moteur Refund (`refund-request-execution.integration.test.ts`)
- **26 / 26 tests passés avec succès sur PostgreSQL réel**.

### 3. Tests d'Intégration Webhook & Lifecycle C3
- **105 / 105 tests passés avec succès sur PostgreSQL réel** (`handle-webhook.integration.test.ts` et `apply-supplement-amendment.integration.test.ts`).

### 4. Tests d'Intégration Web Cron
- `apps/web/src/app/api/cron/expire-holds/route.test.ts` : 11 / 11 passés.
- `apps/web/src/app/api/cron/reconcile-payments/route.test.ts` : 9 / 9 passés.

### 5. Régressions Globales
- `packages/core/src/booking-amendments/` : **15 suites, 256 / 256 tests passés (100% verts)**.
- `pnpm run typecheck` : **0 erreur**.
- `pnpm run lint` : **0 erreur**.
- `pnpm --filter @uttily/web build` : **compilation réussie**.
- `git diff --check` : **0 erreur**.
