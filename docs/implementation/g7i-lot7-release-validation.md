# G7I — Lot 7 release validation gate

## Objectif

G7I est une porte de validation de release (stabilisation). Aucune nouvelle
fonctionnalité n'est ajoutée. Seuls les tests transversaux manquants identifiés
par la matrice de couverture et la documentation G7I sont ajoutés.

## Matrice de couverture

| # | Critère | Preuve existante réutilisée (fichier + test) | Nouveau test ajouté (fichier + test) | Résultat | Gap |
|---|---------|----------------------------------------------|--------------------------------------|----------|-----|
| 1 | Chaîne publique end-to-end (search → details → authority → hold → payment → webhook → confirm) | `packages/core/src/public-search/search-offers.integration.test.ts` (searchPublicOffers), `packages/core/src/public-search/get-public-offer-details.integration.test.ts` (getPublicOfferDetails), `packages/core/src/public-search/resolve-public-booking-authority.integration.test.ts` (resolvePublicBookingAuthority), `packages/core/src/payment-transitions/apply-booking-confirmation-flexible.integration.test.ts` (confirmFlexibleDraft) | `packages/core/src/integration/g7i-public-journey.integration.test.ts` — « GAP 1: chain searchPublicOffers → … → applyBookingConfirmation produces CONFIRMED booking with outbox event » | Couvert | none |
| 2 | Isolation multi-tenant des publicProductId (cross-tenant forgery) | `packages/core/src/public-search/resolve-public-booking-authority.integration.test.ts` — « 2. Tenant isolation : Rejette NOT_FOUND si produit et établissement appartiennent à des organisations différentes » | `packages/core/src/integration/g7i-public-journey.integration.test.ts` — « GAP 2: resolvePublicBookingAuthority rejects forged publicVariantId from another organization » (variant forgery cross-tenant ; product+location mismatch already covered by existing test #2 in resolve-public-booking-authority.integration.test.ts ; new test adds variant forgery scenario) | Couvert | none |
| 3 | Cohérence des intervalles semi-ouverts [start, end) à travers search→hold→checkout | `packages/core/src/booking-drafts/create-booking-draft-flexible.test.ts` (vérifie blockedStartAt/blockedEndAt), `packages/core/src/payment-transitions/apply-booking-confirmation-flexible.integration.test.ts` (copie blocked_start_at/blocked_end_at) | `packages/core/src/integration/g7i-public-journey.integration.test.ts` — « GAP 3: blockedStartAt/blockedEndAt follow semi-open [start, end) convention — adjacent block starting at previous block end does not overlap » (transversal semi-open interval integration ; unit arithmetic covered by delta-segments.test.ts ; new test verifies actual DB blocks through real confirmation + adjacent hold flow) | Couvert | none |
| 4 | client_secret non loggé dans les erreurs fermées | `packages/core/src/payment-initiation/initiate-payment.integration.test.ts` — vérifie `paymentJson.not.toContain('client_secret')`, `packages/core/src/webhook-handler/errors.ts` (doc: « Le client_secret et les données de carte ne doivent JAMAIS apparaître ») | `packages/core/src/integration/g7i-security-sentinel.test.ts` — static analysis sentinel checking all production WebhookHandlerError constructor sites for client_secret leakage + closed error code verification | Couvert | none |
| 5 | Navigation clavier, responsive mobile, erreurs accessibles (Web) | `apps/web/src/app/dashboard/[orgId]/page.g7g.test.ts` (pattern static analysis), `apps/web/src/app/[locale]/search/search-form.tsx` (htmlFor, aria-describedby), `apps/web/src/app/[locale]/search/search-results.tsx` (aria-live, role), `apps/web/src/app/checkout/[draftId]/checkout-client.tsx` (role="alert", aria-busy) | `apps/web/src/app/g7i-a11y-ux.test.ts` — « search-form.tsx: labels use htmlFor… », « search-results.tsx: aria-live… », « checkout-client.tsx: aria-live, role="alert"… », « mobile-responsive: search/offer page has responsive CSS media queries » | Couvert | none |
| 6 | Documentation G7I (matrice de validation) | N/A (nouvelle documentation) | `docs/implementation/g7i-lot7-release-validation.md` (ce document) | Couvert | none |
| 7 | Amendment expiration (supplement lifecycle) | `packages/core/src/booking-amendments/supplement-lifecycle.integration.test.ts` — couvre l'expiration des amendements | N/A (gap réfuté — couverture existante suffisante) | Couvert | none |

## Fichiers créés

1. `packages/core/src/integration/g7i-public-journey.integration.test.ts` — Tests
   d'intégration PostgreSQL couvrant GAP 1 (chaîne end-to-end), GAP 2 (cross-tenant
   forgery), GAP 3 (intervalles semi-ouverts).
2. `packages/core/src/integration/g7i-security-sentinel.test.ts` — Tests sentinelles
   unitaires couvrant GAP 4 (client_secret non loggé, codes d'erreur fermés sans
   détails SQL/provider).
3. `apps/web/src/app/g7i-a11y-ux.test.ts` — Tests d'analyse statique couvrant GAP 5
   (labels htmlFor, aria-live, role="alert", responsive CSS, navigation clavier).
4. `docs/implementation/g7i-lot7-release-validation.md` — Ce document (GAP 6).

## Règles suivies

- Aucune nouvelle dépendance ajoutée.
- Aucun fichier source existant modifié (uniquement nouveaux fichiers de test + doc).
- Aucun Playwright ou rendu DOM (tests web en analyse statique readFileSync).
- Tests d'intégration PostgreSQL utilisent le pattern `setupIntegrationTestDb`
  (skip local sans DATABASE_URL, échec CI si base injoignable).
- Tests focalisés — pas de duplication de la couverture existante.
