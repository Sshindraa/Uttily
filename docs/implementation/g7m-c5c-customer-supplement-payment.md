# G7M-C5-C : Paiement client du supplément d'amendement via Stripe Elements

## 1. Objectif et périmètre

Ce lot implémente le parcours de paiement en ligne sécurisé du supplément tarifaire d'une modification de réservation par le client (`customer_user_id`), via Stripe Elements :

1. Le loueur confirme une modification de type `SUPPLEMENT` avec blocage d'inventaire temporaire (10 minutes).
2. L'interface loueur affiche un panneau épuré avec un bouton principal « Copier le lien de paiement » et un lien secondaire « Voir la réservation », sans aucun champ d'entrée ni texte exposant l'URL ou l'UUID.
3. Le client non authentifié ouvrant `/checkout/amendment/[amendmentId]` est redirigé vers `/sign-in` avec le paramètre `redirectUrl` interne encodé (`/sign-in?redirectUrl=%2Fcheckout%2Famendment%2F[amendmentId]`).
4. L'utilisateur connecté doit correspondre exactement à `bookings.customer_user_id` (vérifié dans la clause SQL `WHERE`).
5. Le client visualise le montant, l'échéance formatée avec le fuseau horaire autoritaire de l'établissement (`locations.time_zone`), et un bouton principal unique « Payer X € ».
6. Stripe PaymentElement initialise et gère le paiement avec réutilisation de l'intent si une tentative non terminale est active.
7. Après confirmation du paiement (`stripe.confirmPayment({ redirect: 'if_required' })`), l'interface affiche le message asynchrone exact :
   « Paiement soumis. La modification sera appliquée automatiquement après confirmation du paiement. » sans annoncer prématurément que la réservation est déjà modifiée (le webhook C3 et le lifecycle C4-A assurent l'application finale).

## 2. Architecture et composants livrés

### 2.1 Core — Read Model de consultation client (`packages/core`)

- **`getSupplementCheckoutSummary`** (`packages/core/src/booking-amendments/get-supplement-checkout-summary.ts`) :
  - Signature : `getSupplementCheckoutSummary(db: DatabaseClient, input: GetSupplementCheckoutInput, options?: GetSupplementCheckoutOptions)`.
  - Signature `GetSupplementCheckoutInput` : `{ amendmentId: string; customerUserId: string }`.
  - Signature `GetSupplementCheckoutOptions` : `{ asOf?: Date }` (défaut : `new Date()`).
  - **Autorité et isolation multi-tenant/customer** :
    - Requête purement en lecture (`SELECT` uniquement), jointure stricte `booking_amendments` -> `bookings` -> `locations`.
    - Clause SQL directe `WHERE booking_amendments.id = amendmentId AND bookings.customer_user_id = customerUserId`.
    - Tout amendement inexistant, d'un autre utilisateur ou d'une autre organisation retourne `{ kind: 'NOT_FOUND' }` sans fuite.
    - Tout type d'amendement non-`SUPPLEMENT` (`NEUTRAL`, `REFUND`) retourne `{ kind: 'NOT_FOUND' }`.
    - Validation du fuseau horaire : extrait exclusivement de `locations.time_zone` et validé via `Intl.DateTimeFormat(undefined, { timeZone })`. Si vide ou invalide, retourne `{ kind: 'INVALID_STATE' }` sans aucun fallback silencieux.
  - **Projection d'états fermée du cycle de vie** :
    - Si `status = 'EXPIRED'` : retourne `{ kind: 'EXPIRED' }`, même si un paiement tardif est `SUCCEEDED`.
    - Si `status IN ('READY_TO_APPLY', 'APPLIED')` :
      - Retourne `{ kind: 'PAID' }` uniquement si `payment.status === 'SUCCEEDED'`, aucune tentative active, et une tentative `SUCCEEDED` cohérente existe avec `providerPaymentIntentId` non vide et `providerStatus === 'succeeded'`.
      - Toute incohérence terminale retourne `{ kind: 'INVALID_STATE' }`.
    - Si `status = 'HOLD_PENDING'` :
      - Si `asOf >= hold_deadline` : retourne `{ kind: 'EXPIRED' }`.
      - Si `payment.status === 'SUCCEEDED'` : retourne `{ kind: 'INVALID_STATE' }` (l'amendement n'a pas encore transité).
      - Exige exactement 1 tentative active parmi `['PENDING_PROVIDER', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING']`. Zéro tentative ou plus d'une tentative active retourne `{ kind: 'INVALID_STATE' }`.
      - Vérifie la cohérence du tuple complet sur `amendment_payments` (`organizationId`, `bookingId`, `amendmentId`, `customerUserId`, devise EUR, montant entier strictement positif).
      - Si `payment.status === 'PENDING_PROVIDER'` : exige tentative `PENDING_PROVIDER` sans données provider (`providerPaymentIntentId == null` et `providerStatus == null`). Si données présentes -> `INVALID_STATE`.
      - Si `payment.status === 'REQUIRES_PAYMENT_METHOD'` : exige tentative identique avec `providerPaymentIntentId` non vide et `providerStatus === 'requires_payment_method'`. Sinon -> `INVALID_STATE`.
      - Si `payment.status === 'REQUIRES_ACTION'` : exige tentative identique avec `providerPaymentIntentId` non vide et `providerStatus === 'requires_action'`. Sinon -> `INVALID_STATE`.
      - Si `payment.status === 'PROCESSING'` :
        - Sans provider (ou sans status provider) : retourne `{ kind: 'PROCESSING' }`.
        - Avec statut provider `requires_payment_method` ou `requires_action` : retourne `{ kind: 'PAYABLE', amountMinor, currency, holdDeadline, timeZone }` pour permettre la reprise sur le même PaymentIntent.
        - Avec statut provider `processing` ou `succeeded` : retourne `{ kind: 'PROCESSING' }`.
        - Autre statut provider inattendu : retourne `{ kind: 'INVALID_STATE' }`.
    - Si `status IN ('CANCELLED', 'FAILED')` : retourne `{ kind: 'INVALID_STATE' }`.
  - **Preuve d'absence d'écriture** : validée par comptage des tables dans les tests PostgreSQL réels (zéro insertion/modification).

### 2.2 Web — Server Action sécurisée (`apps/web`)

- **`initiateSupplementPaymentAction`** (`apps/web/src/app/actions/booking-amendments.ts`) :
  - Entrée : `{ amendmentId: string }`.
  - Horodatage d'invocation unique : `asOf = new Date()`.
  - Authentification : `getAuthenticatedUser()`, retourne `{ kind: 'ERROR', code: 'UNAUTHENTICATED' }` si absent.
  - Résolution d'autorité serveur : clause SQL `WHERE booking_amendments.id = amendmentId AND bookings.customer_user_id = user.id`.
  - Validations strictes avant construction du provider :
    - `holdDeadline` absent ou invalide -> `{ kind: 'ERROR', code: 'UNAVAILABLE' }`.
    - `row.type !== 'SUPPLEMENT'` ou customer mismatch -> `{ kind: 'ERROR', code: 'NOT_FOUND' }`.
    - `asOf >= row.holdDeadline` -> `{ kind: 'ERROR', code: 'EXPIRED' }`.
    - Configuration Stripe invalide -> `{ kind: 'ERROR', code: 'UNAVAILABLE' }`.
  - Appel canonique : `initiateSupplementPayment(db, { ... }, { now: asOf })` (Lot C2).
  - Normalisation stricte de la réponse :
    - Succès : `{ kind: 'READY', clientSecret: string }`.
    - Aucun identifiant technique (`amendmentPaymentId`, `amendmentPaymentAttemptId`, `providerPaymentIntentId`, `bookingId`, `organizationId`, `customerUserId`) n'est retourné au client.
    - Erreurs mappées sans fuite : `UNAUTHENTICATED`, `NOT_FOUND`, `EXPIRED`, `IN_PROGRESS`, `INVALID_STATE`, `UNAVAILABLE`, `TEMPORARY_ERROR`.

### 2.3 Web — Page et composant de checkout client (`apps/web`)

- **Page Server Component** (`apps/web/src/app/checkout/amendment/[amendmentId]/page.tsx`) :
  - Authentification avec redirection `redirect('/sign-in?redirectUrl=' + encodeURIComponent('/checkout/amendment/' + encodeURIComponent(amendmentId)))` si non connecté.
  - Validation du paramètre `amendmentId` (UUID v4).
  - Appel de `getSupplementCheckoutSummary`.
  - Rendu des états distincts :
    - `NOT_FOUND` : Message neutre « Paiement introuvable ».
    - `EXPIRED` : Message explicite « Délai de paiement expiré ».
    - `PAID` : Message rassurant « Modification déjà réglée ».
    - `PROCESSING` : Message d'attente « Paiement en cours de traitement ».
    - `INVALID_STATE` : Message clair « Paiement indisponible ».
    - `PAYABLE` : Rendu du composant interactif `SupplementCheckoutClient`.

- **Composant Client Elements** (`apps/web/src/app/checkout/amendment/[amendmentId]/supplement-checkout-client.tsx`) :
  - Intégration Stripe Elements (`@stripe/react-stripe-js`, `loadStripe(publishableKey)`).
  - Auto-initiation immédiate au montage via `useEffect`, protégée contre les doubles invocations en React StrictMode avec `useRef`.
  - Rendu épuré :
    - Affichage de l'état de préparation « Préparation du paiement sécurisé… ».
    - Montant formaté et date d'échéance formatée avec le fuseau autoritaire (avec fallback sûr "date non disponible" si date invalide).
    - Bouton d'action principal unique « Payer X € ».
    - Les composants `<Elements>` et `<PaymentElement>` restent montés pendant `stripe.confirmPayment` (état de soumission géré en interne via `submitting`).
  - Helpers purs extraits et testés unitairement :
    - `isHoldExpired` : calcul exact d'échéance avec fail-closed.
    - `mapStripeErrorToSafeMessage` : mapping strict sans fuite d'erreur brute.
    - `canSubmitPayment` : décision d'autorisation de soumission.
    - `formatHoldDeadline` et `formatAmount` : formatage localisé et résilient.
  - Messages d'erreur strictement statiques et sanitisés.
  - Message de confirmation différé préservé exactement :
    « Paiement soumis. La modification sera appliquée automatiquement après confirmation du paiement. »

### 2.4 Web — Handoff loueur & lien partageable (`apps/web`)

- **Formulaire d'amendement loueur** (`apps/web/src/app/dashboard/[orgId]/operations/[bookingId]/amend/amend-booking-form.tsx`) :
  - État `PAYMENT_REQUIRED` épuré :
    - Action principale : bouton « Copier le lien de paiement » (copie une URL absolue basée sur `window.location.origin`).
    - Action secondaire : lien « Voir la réservation ».
    - Suppression complète du label et de l'input contenant l'URL/UUID.
    - En cas d'échec ou d'absence de la Clipboard API : affichage exclusif de `Impossible de copier automatiquement.` sans jamais divulguer l'URL ni l'UUID.
    - Feedback accessible : conteneur `role="status"` et `aria-live="polite"`.

## 3. Matrice de conformité aux invariants et garde-fous

| Exigence / Invariant | Statut | Preuve / Validation |
| :--- | :--- | :--- |
| Auth client stricte (`bookings.customer_user_id`) | Conforme | Clause SQL dans `getSupplementCheckoutSummary` et `initiateSupplementPaymentAction`. Tests unitaire + Postgres. |
| Timezone autoritaire `locations.time_zone` | Conforme | Validation `Intl.DateTimeFormat`, zéro fallback Paris, tests timezones réels + invalides. |
| Reprise de PaymentIntent non terminal | Conforme | Projection `PROCESSING` avec `requires_payment_method`/`requires_action` -> `PAYABLE`. |
| Aucune fuite d'existence (404/NOT_FOUND indistinguable) | Conforme | Retourne `{ kind: 'NOT_FOUND' }` pour amendement inexistant, mauvais user, autre org, ou type non-SUPPLEMENT. |
| ClientSecret en mémoire uniquement (zéro persistence DB) | Conforme | Transmis en mémoire à Elements. Absent du schéma DB, des tables d'audit et de l'outbox. |
| Zéro identifiant technique exposé | Conforme | Retourne uniquement `{ kind: 'READY', clientSecret }`. |
| Suppression de l'input URL côté loueur | Conforme | Aucun champ textuel, copie presse-papier absolue sécurisée, feedback d'échec sans URL/UUID. |
| Message de succès sans annonce prématurée | Conforme | « Paiement soumis. La modification sera appliquée automatiquement après confirmation du paiement. » |
| Aucun nouveau package ou produit Stripe | Conforme | Réutilisation stricte de `@stripe/react-stripe-js` et `@uttily/core`. |
| Zéro migration de schéma | Conforme | Aucune migration ajoutée. |
| Test PostgreSQL reproductible | Conforme | Utilisation de `assertLocalhost`, base dédiée, `runMigrations(testUrl)`, nettoyage `afterAll`. |

## 4. Tests et couverture (110 tests automatisés)

- **Tests unitaires Core** (`packages/core/src/booking-amendments/get-supplement-checkout-summary.test.ts`) : 14 tests passés.
- **Tests intégration PostgreSQL Core** (`packages/core/src/booking-amendments/get-supplement-checkout-summary.integration.test.ts`) : 17 tests réels passés.
- **Tests unitaires Server Actions** (`apps/web/src/app/actions/booking-amendments.test.ts`) : 33 tests passés.
- **Tests intégration PostgreSQL Server Actions** (`apps/web/src/app/actions/supplement-payment.integration.test.ts`) : 4 tests réels passés.
- **Tests Web Checkout Page & Client Logic** (`apps/web/src/app/checkout/amendment/[amendmentId]/supplement-checkout.test.tsx`) : 21 tests passés :
  - 7 tests Server Component (redirections, 404, états du cycle de vie).
  - 12 tests unitaires de logique pure client (expiration exacte, mapping sécurisé Stripe, décision de soumission, formatage).
  - 2 tests de rendu statique (montant, fuseau horaire, absence de fuite d'UUID).
- **Tests formulaire d'amendement loueur** (`apps/web/src/app/dashboard/[orgId]/operations/[bookingId]/amend/amend-booking.test.tsx`) : 21 tests passés (dont 3 tests spécifiques G7M-C5-C sur l'absence d'input et la copie sécurisée).
