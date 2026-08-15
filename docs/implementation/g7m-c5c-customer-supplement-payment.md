# G7M-C5-C — Paiement authentifié par le client du supplément via Stripe Elements

## 1. Contexte et objectif

Le lot G7M-C5-C clôture la chaîne fonctionnelle et financière des modifications de réservations à supplément (`SUPPLEMENT`, delta > 0 €).
Il permet au client titulaire de la réservation de payer son supplément d'amendement de manière authentifiée, sécurisée et isolée via Stripe PaymentElement (`/checkout/amendment/[amendmentId]`), et fournit au loueur un lien de paiement partageable depuis le formulaire d'amendement opérationnel.

Parcours complet exécuté :
1. Le loueur confirme une modification avec supplément (Lot C5-B).
2. L'interface loueur affiche un lien de paiement partageable `/checkout/amendment/[amendmentId]` avec bouton « Copier le lien de paiement » et retour d'accessibilité immédiat (`role="status"`).
3. Le client ouvre l'URL `/checkout/amendment/[amendmentId]`.
4. Le client doit être authentifié et être strictement `bookings.customer_user_id`. En cas d'inadéquation (non authentifié, mauvais utilisateur, autre organisation, amendement inexistant), la réponse extérieure est indistinguable (`NOT_FOUND`), sans aucune fuite d'existence ni de statut.
5. Le client visualise une vue épurée : montant du supplément, échéance du hold et formulaire Stripe Elements avec bouton principal « Payer X € ».
6. La Server Action `initiateSupplementPaymentAction` résout autoritairement l'organisation, le booking et le customer côté serveur, appelle `initiateSupplementPayment` (Lot C2) et retourne uniquement `{ kind: 'READY', clientSecret }`. Le `clientSecret` est conservé en mémoire client et jamais persisté.
7. Après confirmation du paiement (`stripe.confirmPayment({ redirect: 'if_required' })`), l'interface affiche le message asynchrone exact :
   « Paiement soumis. La modification sera appliquée automatiquement après confirmation du paiement. » sans annoncer prématurément que la réservation est déjà modifiée (le webhook C3 et le lifecycle C4-A assurent l'application finale).

## 2. Architecture et composants livrés

### 2.1 Core — Read Model de consultation client (`packages/core`)

- **`getSupplementCheckoutSummary`** (`packages/core/src/booking-amendments/get-supplement-checkout-summary.ts`) :
  - Signature : `getSupplementCheckoutSummary(db: DatabaseClient, input: GetSupplementCheckoutInput, options?: GetSupplementCheckoutOptions)`.
  - Signature `GetSupplementCheckoutInput` : `{ amendmentId: string; customerUserId: string }`.
  - Signature `GetSupplementCheckoutOptions` : `{ asOf?: Date }` (défaut : `new Date()`).
  - **Autorité et isolation multi-tenant/customer** :
    - Requête purement en lecture (`SELECT` uniquement), jointure stricte `booking_amendments` -> `bookings` -> `organizations`.
    - Clause `WHERE booking_amendments.id = amendmentId AND bookings.customer_user_id = customerUserId`.
    - Tout amendement inexistant, d'un autre utilisateur ou d'une autre organisation retourne `{ kind: 'NOT_FOUND' }` sans fuite.
    - Tout type d'amendement non-`SUPPLEMENT` (`NEUTRAL`, `REFUND`) retourne `{ kind: 'NOT_FOUND' }`.
  - **Projection d'états du cycle de vie** :
    - Si `asOf >= hold_deadline` ou `status = 'EXPIRED'` : retourne `{ kind: 'EXPIRED' }`.
    - Si `status IN ('READY_TO_APPLY', 'APPLIED')` : retourne `{ kind: 'PAID' }`.
    - Si `status = 'HOLD_PENDING'` :
      - Vérifie la cohérence du paiement `amendment_payments` et de la tentative `amendment_payment_attempts`.
      - Si attempt `REQUIRES_PAYMENT_METHOD` ou `REQUIRES_CONFIRMATION` : retourne `{ kind: 'PAYABLE', amountMinor, currency, holdDeadline }`.
      - Si attempt `PROCESSING` : retourne `{ kind: 'PROCESSING' }`.
      - Si attempt `SUCCEEDED` : retourne `{ kind: 'PAID' }`.
      - Si attempt incohérente ou `FAILED` terminal avec amendement `HOLD_PENDING` : retourne `{ kind: 'INVALID_STATE' }`.
    - Si `status IN ('CANCELLED', 'FAILED')` : retourne `{ kind: 'INVALID_STATE' }`.
  - **Preuve d'absence d'écriture** : 8 tests PostgreSQL vérifient qu'aucun enregistrement n'est inséré, mis à jour ou supprimé dans aucune table.

### 2.2 Web — Server Action sécurisée (`apps/web`)

- **`initiateSupplementPaymentAction`** (`apps/web/src/app/actions/booking-amendments.ts`) :
  - Entrée : `{ amendmentId: string }`.
  - Authentification : `getAuthenticatedUser()`, retourne `{ kind: 'ERROR', code: 'UNAUTHENTICATED' }` si absent.
  - Résolution d'autorité serveur : dérive l'organisation et le customer depuis la base de données.
  - Vérification de l'échéance : échec immédiat `{ kind: 'ERROR', code: 'EXPIRED' }` si `now >= holdDeadline`.
  - Vérification d'environnement : `STRIPE_SECRET_KEY` et `STRIPE_ENVIRONMENT`.
  - Appel canonique : `initiateSupplementPayment` (Lot C2).
  - Normalisation stricte de la réponse :
    - Succès : `{ kind: 'READY', clientSecret: string }`.
    - Aucun identifiant technique (`amendmentPaymentId`, `amendmentPaymentAttemptId`, `providerPaymentIntentId`, `bookingId`, `organizationId`, `customerUserId`) n'est retourné au client.
    - Erreurs mappées sans fuite : `UNAUTHENTICATED`, `NOT_FOUND`, `EXPIRED`, `IN_PROGRESS`, `INVALID_STATE`, `TEMPORARY_ERROR`.

### 2.3 Web — Page et composant de checkout client (`apps/web`)

- **Page Server Component** (`apps/web/src/app/checkout/amendment/[amendmentId]/page.tsx`) :
  - Authentification avec redirection `redirect('/sign-in?redirectUrl=...')` si non connecté.
  - Validation du paramètre `amendmentId` (UUID v4).
  - Appel de `getSupplementCheckoutSummary`.
  - Rendu des états distincts :
    - `NOT_FOUND` : Message neutre « Modification introuvable ».
    - `EXPIRED` : Message explicite « Délai de paiement expiré ».
    - `PAID` : Message rassurant « Modification déjà payée ».
    - `PROCESSING` : Message d'attente « Paiement en cours de traitement ».
    - `INVALID_STATE` : Message clair « Modification non disponible ».
    - `PAYABLE` : Rendu du composant interactif `SupplementCheckoutClient`.

- **Composant Client Elements** (`apps/web/src/app/checkout/amendment/[amendmentId]/supplement-checkout-client.tsx`) :
  - Intégration Stripe Elements (`@stripe/react-stripe-js`, `loadStripe(publishableKey)`).
  - Étape 1 : Appel de `initiateSupplementPaymentAction` pour obtenir le `clientSecret` en mémoire vive.
  - Étape 2 : Affichage de `Elements options={{ clientSecret }}` avec `PaymentElement`.
  - Étape 3 : Soumission via `stripe.confirmPayment({ elements, redirect: 'if_required' })`.
  - Étape 4 : Rendu du message de confirmation différé :
    « Paiement soumis. La modification sera appliquée automatiquement après confirmation du paiement. »
  - Gestion accessible des erreurs et des états de chargement.

### 2.4 Web — Handoff loueur & lien partageable (`apps/web`)

- **Formulaire d'amendement loueur** (`apps/web/src/app/dashboard/[orgId]/operations/[bookingId]/amend/amend-booking-form.tsx`) :
  - État `PAYMENT_REQUIRED` enrichi :
    - URL partageable : `/checkout/amendment/{amendmentId}`.
    - Action principale : bouton « Copier le lien de paiement » utilisant `navigator.clipboard.writeText`.
    - Feedback accessible : conteneur `role="status"` et `aria-live="polite"` affichant « Lien copié dans le presse-papier ! ».
    - Action secondaire discrète : lien « Voir la réservation ».
    - Aucun UUID brut affiché dans le texte visible.

## 3. Matrice de conformité aux invariants et garde-fous

| Exigence / Invariant | Statut | Preuve / Validation |
| :--- | :--- | :--- |
| Auth client stricte (`bookings.customer_user_id`) | Conforme | Jointure DB dans `getSupplementCheckoutSummary` et `initiateSupplementPaymentAction`. Tests unitaire + Postgres. |
| Aucune fuite d'existence (404/NOT_FOUND indistinguable) | Conforme | Retourne `{ kind: 'NOT_FOUND' }` pour amendement inexistant, mauvais user, autre org, ou type non-SUPPLEMENT. |
| ClientSecret en mémoire uniquement (zéro persistence DB) | Conforme | Transmis en mémoire à Elements. Absent du schéma DB, des tables d'audit et de l'outbox. |
| Zéro identifiant technique exposé | Conforme | Retourne uniquement `{ kind: 'READY', clientSecret }`. |
| Message de succès sans annonce prématurée | Conforme | « Paiement soumis. La modification sera appliquée automatiquement après confirmation du paiement. » |
| Aucun nouveau package ou produit Stripe | Conforme | Réutilisation stricte de `@stripe/react-stripe-js` et `@uttily/core`. |
| Zéro migration de schéma | Conforme | Aucune migration ajoutée. |
| Zéro envoi email automatique dans ce lot | Conforme | Aucun effet outbox de notification email déclenché dans ce lot. |
| Workspace propre et vérifié | Conforme | Typecheck, lint, format et build web complets validés. |

## 4. Tests et couverture

- **Tests unitaires Core** (`packages/core/src/booking-amendments/get-supplement-checkout-summary.test.ts`) : 14 tests passés.
- **Tests intégration PostgreSQL Core** (`packages/core/src/booking-amendments/get-supplement-checkout-summary.integration.test.ts`) : 8 tests réels passés.
- **Tests unitaires Server Actions** (`apps/web/src/app/actions/booking-amendments.test.ts`) : 33 tests passés.
- **Tests intégration PostgreSQL Server Actions** (`apps/web/src/app/actions/supplement-payment.integration.test.ts`) : 4 tests réels avec FakeStripe passés.
- **Tests composants Web Checkout** (`apps/web/src/app/checkout/amendment/[amendmentId]/supplement-checkout.test.tsx`) : 8 tests passés.
- **Tests formulaire d'amendement loueur** (`apps/web/src/app/dashboard/[orgId]/operations/[bookingId]/amend/amend-booking.test.tsx`) : 19 tests passés.
