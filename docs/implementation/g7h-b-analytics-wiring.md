# G7H-B — Cablage des evenements analytics

- **Statut** : Implante
- **Date** : 2026-08-10
- **ADR** : ADR-022 (amende, section 2.8)
- **Base** : G7H-A (fondations techniques : migration 0035, module Core product-analytics)

## 1. Objectif

Cabler trois evenements product analytics dans les parcours applicatifs reels,
en reutilisant le ledger PostgreSQL append-only de G7H-A :

1. `PUBLIC_SEARCH_PERFORMED` — recherche publique executee avec succes.
2. `BOOKING_ATTEMPTED` — tentative de reservation ayant obtenu une reservation
   d'idempotence.
3. `BOOKING_CONFIRMED` — reservation confirmee atomiquement.

Aucune nouvelle table, aucune migration, aucun provider externe, aucun cookie
ou tracking client n'est introduit. La collecte `PRODUCTION` reste impossible
a activer.

## 2. Fichiers crees

| Fichier | Description |
| --- | --- |
| `packages/core/src/product-analytics/runtime.ts` | Resolveur d'environnement pur et injectable. Retourne `DEVELOPMENT`, `TEST` ou `DISABLED`. `PRODUCTION` est toujours `DISABLED`. |
| `packages/core/src/product-analytics/safe-record.ts` | Enregistreur best-effort avec union fermee `RECORDED` / `DUPLICATE` / `DISABLED` / `FAILED`. Deux variantes : hors transaction (await + try/catch) et dans transaction (savepoint + try/catch). |
| `packages/core/src/product-analytics/runtime.test.ts` | Tests unitaires du resolveur (17 tests). |
| `packages/core/src/product-analytics/safe-record.test.ts` | Tests unitaires du safe recorder (15 tests). |
| `packages/core/src/product-analytics/g7h-b-analytics-wiring.integration.test.ts` | Tests d'integration PostgreSQL (22 tests). |
| `apps/web/src/lib/product-analytics.ts` | Helper Web pour resoudre l'environnement analytics depuis `process.env` avec cache. |

## 3. Fichiers modifies

| Fichier | Changement |
| --- | --- |
| `packages/core/src/product-analytics/index.ts` | Export de `resolveAnalyticsEnvironment`, `safeRecordAnalyticsEvent`, `safeRecordAnalyticsEventInTransaction` et types associes. |
| `packages/core/src/booking-drafts/create-booking-draft.ts` | Ajout du parametre `analyticsEnvironment`, helper `emitBookingAttempted` partage LEGACY/FLEXIBLE, emission apres `reserveKey` et avant la transaction. |
| `packages/core/src/payment-transitions/apply-booking-confirmation.ts` | Ajout du parametre `analyticsEnvironment`, retour de `confirmedAt` depuis l'INSERT du booking, emission `BOOKING_CONFIRMED` dans un savepoint apres l'outbox. |
| `apps/web/src/app/api/public/search/route.ts` | Emission `PUBLIC_SEARCH_PERFORMED` apres une recherche reussie, isolee dans son propre try/catch. |
| `apps/web/src/app/api/public/search/route.test.ts` | Tests analytics : hasResults true/false, pas d'emission sur echec, erreur analytics sans erreur HTTP, sourceId distinct par recherche. |
| `.env.example` | Ajout de `PRODUCT_ANALYTICS_ENVIRONMENT=DEVELOPMENT`. |
| `docs/decisions/ADR-022-product-analytics-privacy-and-retention.md` | Amendement section 2.8. |

## 4. Decisions techniques

### 4.1 BOOKING_ATTEMPTED

- Emis apres `reserveKey` et avant la transaction metier.
- `sourceId = reservation.record.id` (UUID de l'enregistrement d'idempotence).
- `occurredAt = reservation.record.createdAt`.
- Jamais `input.idempotencyKey` comme `sourceId` (non garanti UUID).
- `ACQUIRED`, `PENDING` et `REPLAY` tentent le meme evenement stable.
- `CONFLICT` n'emet pas (payload different = tentative invalide).
- Helper `emitBookingAttempted` partage entre LEGACY et FLEXIBLE.
- Utilise `safeRecordAnalyticsEvent` (hors transaction, `DatabaseClient`).

### 4.2 PUBLIC_SEARCH_PERFORMED

- Emis uniquement apres une recherche executee avec succes.
- `sourceId = crypto.randomUUID()` capture une fois par execution.
- `occurredAt = new Date()` capture une fois par execution.
- `hasResults = result.items.length > 0`.
- L'ecriture analytics est attendue avant la reponse (pas de fire-and-forget).
- Une erreur analytics ne transforme jamais une recherche reussie en erreur
  HTTP (try/catch dedie autour de l'appel analytics).
- Aucun parametre de recherche, identifiant client, session, IP, user-agent ou
  header n'est collecte.
- Chaque execution serveur reussie compte separement.

### 4.3 BOOKING_CONFIRMED

- Emis dans la transaction de confirmation apres la creation du booking et
  l'insertion outbox `BOOKING_CONFIRMED.v1`, avant le retour.
- `sourceId = bookingId`.
- `occurredAt = confirmedAt` retourne par PostgreSQL via `.returning()`.
- Utilise `safeRecordAnalyticsEventInTransaction` (savepoint).
- Une erreur analytics annule uniquement le savepoint, jamais la confirmation.
- Comportement identique pour webhook et reconciliation (partagent
  `applyBookingConfirmation`).

### 4.4 Isolation d'erreur

- `safeRecordAnalyticsEvent` : hors transaction, await + try/catch.
- `safeRecordAnalyticsEventInTransaction` : dans transaction, nested
  transaction (savepoint) + try/catch externe.
- Un simple try/catch autour d'un INSERT qui echoue dans une transaction
  PostgreSQL est interdit (transaction aborted).
- Union fermee : `RECORDED`, `DUPLICATE`, `DISABLED`, `FAILED`.
- Jamais de rethrow vers le chemin metier.
- Logs structures : `eventType` et code d'erreur normalise uniquement.

### 4.5 Environnement et gate PRODUCTION

- `PRODUCT_ANALYTICS_ENVIRONMENT=DEVELOPMENT | TEST | PRODUCTION`.
- `DEVELOPMENT` : collecte autorisee.
- `TEST` : collecte autorisee.
- `PRODUCTION` : toujours `DISABLED` dans G7H-B.
- Absent : `DISABLED`.
- Invalide : `DISABLED` avec diagnostic.
- Aucun mapping depuis `NODE_ENV` ou `STRIPE_ENVIRONMENT`.
- Aucun flag `PRODUCT_ANALYTICS_PRODUCTION_ENABLED`.
- Resolution pure et injectable (`resolveAnalyticsEnvironment`).

### 4.6 Privacy

**Collecte autorisee** : `eventType`, `environment`, `sourceId` (technique),
`occurredAt`, `hasResults` (recherche uniquement).

**Interdit** : `userId`, `customerId`, `organizationId`, `sessionId`, IP,
email, GPS, parametres de recherche, texte, destination, produit, variante,
SKU, serial, identifiant de paiement ou Stripe, notes, payload JSON, donnees
provider.

## 5. Tests

### Tests unitaires (32 tests)

- `runtime.test.ts` (17 tests) : DEVELOPMENT, TEST, PRODUCTION -> DISABLED,
  absent, invalide, purete.
- `safe-record.test.ts` (15 tests) : RECORDED, DUPLICATE, FAILED, DISABLED,
  pas de rethrow, logs sans donnees sensibles, PRODUCTION injecte par cast
  rejete (defense-in-depth).

### Tests Web (15 tests)

- `route.test.ts` : hasResults true/false, pas d'emission sur echec/invalide,
  erreur analytics sans erreur HTTP, sourceId distinct, DISABLED.

### Tests integration PostgreSQL (22 tests)

- `g7h-b-analytics-wiring.integration.test.ts` :
  - BOOKING_ATTEMPTED enregistre avant l'echec metier (LEGACY et FLEXIBLE).
  - Echec metier LEGACY explicitement FAILURE/409/CONFLICT_BLOCK
    (quantity > stock disponible).
  - Echec metier FLEXIBLE explicitement FAILURE/409/CONFLICT_BLOCK
    (quantity > stock disponible, DAY_RANGE + DAILY).
  - sourceId = UUID idempotence, occurredAt = createdAt.
  - Replay -> un seul evenement.
  - Conflict ne compte pas.
  - DISABLED -> aucun evenement.
  - BOOKING_CONFIRMED avec bookingId/confirmedAt.
  - Trigger PostgreSQL reel forçant l'echec BOOKING_CONFIRMED dans le
    savepoint : confirmation reussit, outbox present, zero analytics
    BOOKING_CONFIRMED, aucun message PostgreSQL fuite.
  - Rollback metier ne laisse pas d'evenement.
  - Webhook/reconciliation reellement concurrents (deux connexions
    PostgreSQL, sentinel pg_advisory_lock, timeout borne 30s) :
    un booking, un outbox, un analytics, sourceId et occurredAt exacts.
  - Resultat concurrent exact : reconcilePaymentsBatch
    (claimedCount=1, reconciledCount=1, confirmedCount=1, anomalyCount=0),
    webhook SUCCESS/200.
  - Duplicate webhook (sequentiel) -> un seul booking et un seul evenement.
  - DISABLED -> aucun evenement.
  - Separation DEVELOPMENT/TEST.
  - PRODUCTION injecte par cast dans createBookingDraftWithHold -> aucun
    evenement analytics.
  - PRODUCTION injecte par cast dans safeRecordAnalyticsEvent -> DISABLED
    et zero DB.
  - PRODUCTION injecte par cast dans safeRecordAnalyticsEventInTransaction
    -> DISABLED et zero DB.
  - Aucune ligne PRODUCTION dans toute la table.
  - PUBLIC_SEARCH_PERFORMED avec/sans resultats, sourceId distincts.

## 6. Verification

### Focused verification

Les tests cibles G7H-B sont un sous-ensemble de la suite Core complete.

- Tests unitaires G7H-B : 32 passes (runtime 17 + safe-record 15).
- Tests integration PostgreSQL G7H-B : 22 passes.
- Tests product-analytics (tous) : 211 passes (9 fichiers).
- Tests booking-drafts ciblés : 121 passes (2 fichiers).
- Tests webhook/reconciliation ciblés : 130 passes (3 fichiers).
- Tests Web search route : 15 passes (1 fichier).
- Commande focused globale : 14 fichiers, 462 tests, 0 échec, 0 skip.

### Full Core gate

- Suite Core complete : 84 fichiers, 2175 tests, 0 échec, 0 skip.
- Commande : `pnpm --filter @uttily/core test`.

### Full Web gate

- Suite Web complete : 18 fichiers, 305 tests, 0 échec, 0 skip.
- Commande : `pnpm --filter @uttily/web test`.

### Preuves finales

- Echecs metier LEGACY et FLEXIBLE explicitement FAILURE/409/CONFLICT_BLOCK.
- Trigger PostgreSQL reel forçant l'echec BOOKING_CONFIRMED dans le savepoint.
- Vraie concurrence webhook/reconciliation avec deux connexions, sentinel
  pg_advisory_lock et timeout borne 30s.
- Resultat exact webhook SUCCESS/200.
- Production rejetee par type (ResolvedAnalyticsEnvironment sans PRODUCTION),
  runtime (isCollectableEnvironment) et test PostgreSQL (aucune ligne
  PRODUCTION dans toute la table).

### Checks

- `pnpm lint` : passe.
- `pnpm typecheck` : passe (8 projets).
- `pnpm --filter @uttily/web build` : passe (Next.js 16.2.12).
- `pnpm exec prettier --check` : passe sur tous les fichiers supportes.
- `git diff --check` : passe.
