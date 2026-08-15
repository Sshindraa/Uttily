# G7M-C5-B — Workflow de confirmation d'amendement et application loueur

## 1. Contexte et objectif

Le lot G7M-C5-B complète le parcours loueur initié dans G7M-C5-A en permettant au loueur d'appliquer et de confirmer autoritairement la modification depuis la même interface, avec une seule action principale et sans exposer la complexité financière ou technique sous-jacente (ADR-023 §3-9, §11-13, §15).

Parcours utilisateur exécuté :
1. Le loueur modifie les dates/horaires et/ou les quantités.
2. Il clique sur « Vérifier les changements » pour charger la prévisualisation déterministe Avant / Après.
3. Il clique sur l'unique action principale « Confirmer la modification ».
4. Le serveur recalcule autoritairement la prévisualisation pour valider les prix et les disponibilités physiques (optimistic locking et protection contre les dérives).
5. Le serveur dispatche automatiquement vers le flux de mutation canonique correspondant :
   - **`NEUTRAL`** (delta = 0 €) : application transactionnelle immédiate de l'amendement (`createNeutralBookingAmendment`).
   - **`REFUND`** (delta < 0 €) : application transactionnelle immédiate de l'amendement et création durable de la dette de remboursement `PENDING` avec outbox event `REFUND_REQUESTED` (`createRefundBookingAmendment`).
   - **`SUPPLEMENT`** (delta > 0 €) : pose atomique du hold d'inventaire de 10 minutes, création de l'amendement `HOLD_PENDING`, enregistrement local du paiement `amendment_payments` (`PENDING_PROVIDER`) et tentative initiale (`createSupplementBookingAmendment`), sans appel externe Stripe (réservé à C5-C).
6. L'interface affiche un écran de succès clair et adapté au cas métier, avec un lien d'action unique « Voir la réservation » redirigeant vers la fiche de l'opération.

## 2. Architecture et composants livrés

### 2.1 Core — Orchestrateur canonique de confirmation (`packages/core`)

- **`confirmBookingAmendment`** (`packages/core/src/booking-amendments/confirm-booking-amendment.ts`) :
  - Signature : `confirmBookingAmendment(db: DatabaseClient, authenticatedActor: AuthenticatedUser, organizationId: string, command: ConfirmBookingAmendmentCommand, options?: { now?: Date })`.
  - Contrôle d'autorisation strict : vérifie que l'acteur possède un membership actif avec rôle `OWNER`, `ADMIN` ou `MANAGER` (`requireMembership(membership, LOCATION_MANAGERS)`). Rejette `STAFF` avec `FORBIDDEN`.
  - Validation fail-closed des entrées et du format UUID de l'idempotency key (`validateCommandPayload`).
  - **Gestion d'idempotence préalable** : inspection de `idempotency_records` pour détecter immédiatement les replays (`isReplay: true`) ou les conflits d'empreinte (`IDEMPOTENCY_CONFLICT`) avant tout calcul de prévisualisation, évitant les faux `STALE_EFFECTIVE_BOOKING` sur les rejeux.
  - **Recalcul autoritaire serveur** : réexécute `previewBookingAmendment` pour vérifier sous verrou la validité des dates, la cohérence des prix et la disponibilité physique des exemplaires.
  - **Détection de dérive (`PREVIEW_CHANGED`)** : vérifie que la classification, le delta ou le nouveau total attendus par le client correspondent exactement au recalcul serveur. En cas de dérive (ou de course `FINANCIAL_ACTION_REQUIRED`), retourne proprement `PREVIEW_CHANGED` sans altérer la base.
  - **Dispatch transactionnel** :
    - Classification `NEUTRAL` -> `createNeutralBookingAmendment`.
    - Classification `REFUND` -> `createRefundBookingAmendment`.
    - Classification `SUPPLEMENT` -> `createSupplementBookingAmendment`.
  - **Normalisation des résultats sans fuite d'identifiants techniques** :
    - `APPLIED_NEUTRAL` : `{ kind: 'APPLIED_NEUTRAL', amendmentId, amendmentNumber, bookingId, isReplay }`.
    - `APPLIED_REFUND` : `{ kind: 'APPLIED_REFUND', amendmentId, amendmentNumber, bookingId, refundAmountMinor, currency: 'EUR', isReplay }` (aucun `refundId` exposé).
    - `PAYMENT_REQUIRED` : `{ kind: 'PAYMENT_REQUIRED', amendmentId, amendmentNumber, bookingId, supplementAmountMinor, currency: 'EUR', holdDeadline, isReplay }` (aucun `amendmentPaymentId`, `amendmentPaymentAttemptId` ni `clientSecret` exposé).

- **Types et exports** (`packages/core/src/booking-amendments/types-amendment.ts`, `packages/core/src/booking-amendments/index.ts`) :
  - Export public de `confirmBookingAmendment` et des types `ConfirmBookingAmendmentCommand`, `ConfirmBookingAmendmentAppliedNeutral`, `ConfirmBookingAmendmentAppliedRefund`, `ConfirmBookingAmendmentPaymentRequired`, `ConfirmBookingAmendmentSuccess`, `ConfirmBookingAmendmentResult`.

### 2.2 Web — Server Action sécurisée (`apps/web`)

- **`confirmBookingAmendmentAction`** (`apps/web/src/app/actions/booking-amendments.ts`) :
  - Server Action validant les formats d'entrée et authentifiant l'utilisateur via `requireAmendmentManagerOf(organizationId)`.
  - Mappe les résultats et erreurs Core vers `ActionResult<ConfirmBookingAmendmentSuccess>` avec codes d'erreur fermés et assainis :
    - `APPLIED_NEUTRAL`, `APPLIED_REFUND`, `PAYMENT_REQUIRED` -> `{ ok: true, data: result }`.
    - `FORBIDDEN` -> `{ ok: false, code: 'FORBIDDEN', message: 'Accès non autorisé.' }`.
    - `NOT_FOUND` -> `{ ok: false, code: 'NOT_FOUND', message: 'Réservation introuvable.' }`.
    - `BOOKING_NOT_CONFIRMED` -> `{ ok: false, code: 'VALIDATION', message: 'Seules les réservations confirmées peuvent être modifiées.' }`.
    - `ACTIVE_AMENDMENT_EXISTS` -> `{ ok: false, code: 'CONFLICT_IDEMPOTENCY', message: 'Une modification est déjà en cours sur cette réservation.' }`.
    - `STALE_EFFECTIVE_BOOKING` -> `{ ok: false, code: 'CONFLICT_IDEMPOTENCY', message: 'La réservation a été modifiée entre-temps. Veuillez recharger la page.' }`.
    - `AVAILABILITY_CONFLICT` -> `{ ok: false, code: 'CONFLICT_BLOCK', message: 'Certains articles ne sont plus disponibles pour les dates demandées.' }`.
    - `PREVIEW_CHANGED` -> `{ ok: false, code: 'CONFLICT_BLOCK', message: 'Les conditions ou disponibilités ont changé. Veuillez vérifier à nouveau les changements.' }`.
    - `IDEMPOTENCY_CONFLICT` -> `{ ok: false, code: 'CONFLICT_IDEMPOTENCY', message: 'Une requête différente a déjà été soumise avec la même clé.' }`.
    - `INVALID_INPUT` -> `{ ok: false, code: 'VALIDATION', message: 'Les changements demandés ne peuvent pas être confirmés.' }`.

### 2.3 Web — Interface utilisateur & Accessibilité (`apps/web`)

- **Formulaire de modification et confirmation** (`apps/web/src/app/dashboard/[orgId]/operations/[bookingId]/amend/amend-booking-form.tsx`) :
  - Affiche l'unique bouton d'action principale « Confirmer la modification » sous le bloc de prévisualisation Avant / Après.
  - Invalide automatiquement la prévisualisation et renouvelle la clé d'idempotence dès qu'un champ (date, heure, quantité) est modifié par l'utilisateur.
  - Conserve la même clé d'idempotence pour les rejeux/retries de la même tentative de confirmation.
  - Protection contre le double-submit : désactive tous les champs et boutons pendant la transition (`isBusy`), avec libellé dynamique « Confirmation en cours... ».
  - Gestion accessible des erreurs (`role="alert"`, `aria-live="polite"`, focus automatique `tabIndex={-1}`).
  - **Écrans de succès dédiés** :
    - `NEUTRAL` : « Modification enregistrée » — « La réservation a été mise à jour. »
    - `REFUND` : « Modification enregistrée » — « La réservation a été mise à jour. Le remboursement de [X €] est en cours. »
    - `SUPPLEMENT` : « Modification en attente de paiement » — « La modification est réservée pendant 10 minutes. Le client doit maintenant régler [X €] avant [heure locale]. »
  - Bouton de navigation principal post-succès : « Voir la réservation » redirigeant vers `/dashboard/[orgId]/operations/[bookingId]`.

## 3. Validation et tests

1. **Tests unitaires Core** (`packages/core/src/booking-amendments/confirm-booking-amendment.test.ts`) :
   - 21 tests unitaires couvrant la validation fail-closed, le contrôle de rôle STAFF / absence de membership, la propagation d'erreurs preview, la détection de dérive `PREVIEW_CHANGED`, le dispatch NEUTRAL/REFUND/SUPPLEMENT, le rejeu idempotent et l'absence totale de fuite d'identifiants techniques.
2. **Tests d'intégration PostgreSQL réels** (`packages/core/src/booking-amendments/confirm-booking-amendment.integration.test.ts`) :
   - 11 tests réels sans skip prouvant :
     1. Confirmation `NEUTRAL` appliquée immédiatement avec projection effective mise à jour.
     2. Confirmation `REFUND` appliquée avec refund `PENDING` et outbox event `REFUND_REQUESTED`.
     3. Confirmation `SUPPLEMENT` avec hold local (`HOLD_PENDING`), paiement local `PENDING_PROVIDER` et échéance de hold de 10 minutes.
     4. Rejeu idempotent retournant `isReplay: true` sans duplication de lignes ou paiements.
     5. Détection de conflit d'idempotence (`IDEMPOTENCY_CONFLICT`).
     6. Verrou optimiste et détection de version obsolète (`STALE_EFFECTIVE_BOOKING`).
     7. Détection de dérive client/serveur (`PREVIEW_CHANGED`).
     8. Isolation multi-tenant stricte (rejet de l'organisation B avec `NOT_FOUND`).
     9. Refus du rôle `STAFF` avec `FORBIDDEN`.
     10. Concurrence réelle et double-submit sans corruption ni deadlock.
     11. Zéro appel externe provider : aucune création prématurée d'intent Stripe.
3. **Tests Web** :
   - `apps/web/src/app/actions/booking-amendments.test.ts` (17 tests action).
   - `apps/web/src/app/dashboard/[orgId]/operations/[bookingId]/amend/amend-booking.test.tsx` (18 tests UI).
4. **Vérifications globales du monorepo** :
   - `pnpm typecheck` : 100% vert sur tous les 8 packages/apps du workspace.
   - `pnpm lint` : 100% vert (0 warning, 0 error).
   - `pnpm format:check` : 100% vert.
   - Tests Core : 1379 tests passés à 100%.
   - Tests Web : 246 tests passés à 100%.
