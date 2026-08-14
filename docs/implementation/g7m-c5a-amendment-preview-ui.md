# G7M-C5-A — Fondation canonique de prévisualisation et première interface loueur

## 1. Contexte et objectif

Le lot G7M-C5-A implémente la fondation canonique de prévisualisation (read-only) et la première interface loueur pour les modifications de réservation (ADR-023 §6).

Depuis la fiche d'une réservation `CONFIRMED`, un loueur autorisé (`OWNER`, `ADMIN`, `MANAGER`) peut :
1. Accéder à l'écran de modification via le bouton « Modifier la réservation ».
2. Ajuster les dates/heures de la réservation (`DAY_RANGE` ou `TIME_RANGE`) et les quantités des variantes réservées.
3. Obtenir une prévisualisation déterministe et strictement en lecture seule des changements :
   - Comparaison Avant / Après (dates effectives, quantités par article, totaux contractuels en unités mineures et affichage formaté en euros).
   - Classification de la modification (`NEUTRAL`, `REFUND`, `SUPPLEMENT`).
   - Estimation de la commission Uttily, calculée proportionnellement au taux effectif de la réservation originale en unités mineures, et du net loueur pour les suppléments.
   - Vérification de la disponibilité physique sans pose de verrous, de holds ou d'écritures en base (fail-closed strict).

## 2. Architecture et composants livrés

### 2.1 Core — Prévisualisation canonique read-only (`packages/core`)
- **`previewBookingAmendment`** (`packages/core/src/booking-amendments/preview-booking-amendment.ts`) :
  - Signature : `previewBookingAmendment(db: DatabaseClient, authenticatedActor: AuthenticatedUser, organizationId: string, command: PreviewBookingAmendmentCommand)`.
  - Contrôle d'autorisation tenant-safe via `requireMembership(membership, LOCATION_MANAGERS)`.
  - Validation des entrées partagée (`validateCommandPayload`).
  - Optimistic locking sur `expectedLastAppliedAmendmentNumber`.
  - Rejet si réservation non `CONFIRMED` (`BOOKING_NOT_CONFIRMED`).
  - Rejet si un amendement actif existe (`ACTIVE_AMENDMENT_EXISTS`).
  - Résolution et devis via `quoteFlexiblePricing` avec support complet `TIME_RANGE` et `DAY_RANGE`.
  - Diff de lignes via `computeLineDiff`.
  - Classification via `classifyDelta`.
  - Calcul de la commission proportionnelle pour les suppléments via `calculateSupplementCommission` (fail-closed si réservation introuvable).
  - Vérification indicative de la disponibilité physique (`checkPreviewAvailability`) avec filtrage strict `organization_id` et résolution obligatoire du bloc source (fail-closed strict sans fallback silencieux).
  - **Garantie read-only** : aucune écriture en base (0 amendement, block, paiement, refund, outbox ou clé d'idempotence, prouvé par test tenant-scoped sur 10 tables).

- **`getEffectivePricingIntent`** (`packages/core/src/booking-amendments/get-effective-pricing-intent.ts`) :
  - Résolution canonique tenant-scoped de l'intention tarifaire effective :
    - Inspecte le dernier amendement `APPLIED` (via `booking_amendment_lines.pricing_snapshot.intentSnapshot`) pour refléter fidèlement l'intention issue d'un précédent amendement.
    - Sinon, résout l'intention depuis le snapshot flexible de la réservation (`flexible-pricing-v1`).
    - Pour les réservations antérieures (`legacy-daily-v1` ou sans snapshot flexible), dérive canoniquement `DAY_RANGE` dans le fuseau du lieu.
    - Échoue de manière fermée (`INVALID_INTENT`) en cas de corruption ou d'incohérence multi-lignes.

- **Types et exports** (`packages/core/src/booking-amendments/types-amendment.ts`, `packages/core/src/booking-amendments/index.ts`) :
  - `PreviewBookingAmendmentCommand`, `PreviewLineDiffEntry`, `PreviewBookingAmendmentSuccess`, `PreviewBookingAmendmentResult`, `PreviewBookingAmendmentError`, `isPreviewBookingAmendmentErrorCode`, `getEffectivePricingIntent`, `GetEffectivePricingIntentResult`.

### 2.2 Web — Sécurité et Server Actions (`apps/web`)
- **`requireAmendmentManagerOf` & `getAmendmentEntryState`** (`apps/web/src/lib/amendment-auth.ts`) :
  - Authentification et contrôle de membership strict (`OWNER`, `ADMIN`, `MANAGER`). Rejette `STAFF` avec `FORBIDDEN`.
  - Fonction pure `getAmendmentEntryState` pour déterminer l'éligibilité d'accès.
- **`previewBookingAmendmentAction`** (`apps/web/src/app/actions/booking-amendments.ts`) :
  - Server Action validant les formats UUIDs et les intentions (`TIME_RANGE` et `DAY_RANGE`), mappant les résultats métier vers `ActionResult<PreviewBookingAmendmentSuccess>` avec codes fermés (`CONFLICT_BLOCK`, `CONFLICT_IDEMPOTENCY`, `VALIDATION`, `FORBIDDEN`, `NOT_FOUND`).

### 2.3 Web — Interface utilisateur (`apps/web`)
- **Page de détail opérations** (`apps/web/src/app/dashboard/[orgId]/operations/[bookingId]/page.tsx`) :
  - Affiche l'entrée « Modifier la réservation » uniquement si `getAmendmentEntryState` autorise l'action (sans `role="status"` statique).
- **Page de modification** (`apps/web/src/app/dashboard/[orgId]/operations/[bookingId]/amend/page.tsx`) :
  - Server Component vérifiant l'accès, résolvant l'intention effective autoritative via `getEffectivePricingIntent` et chargeant les labels sans fallback inventé.
- **Helper de construction d'entrée** (`apps/web/src/app/dashboard/[orgId]/operations/[bookingId]/amend/build-preview-input.ts`) :
  - Fonction pure `buildPreviewBookingAmendmentInput` validant les dates, heures et quantités non nulles.
- **Composant de présentation du résultat** (`apps/web/src/app/dashboard/[orgId]/operations/[bookingId]/amend/amendment-preview-result.tsx`) :
  - Rendu accessible et responsive du diff Avant / Après, badge de classification, ventilation des articles, bilan financier et notices explicatives.
- **Formulaire de modification** (`apps/web/src/app/dashboard/[orgId]/operations/[bookingId]/amend/amend-booking-form.tsx`) :
  - Client Component orchestrant les états utilisateur, focus management accessible (`tabIndex={-1}`) et bouton unique « Vérifier les changements ».

## 3. Validation et tests

1. **Tests unitaires Core** :
   - `packages/core/src/booking-amendments/preview-booking-amendment.test.ts` (18 tests unitaires).
2. **Tests d'intégration PostgreSQL réels** :
   - `packages/core/src/booking-amendments/preview-booking-amendment.integration.test.ts` (12 tests réels sans skip prouvant la parité NEUTRAL, REFUND, SUPPLEMENT avec commission et net, TIME_RANGE, 0 écriture tenant-scoped sur 10 tables, fail-closed bloc source corrompu, isolation multi-tenant, contrôle de rôle STAFF, verrou optimiste et conflits de stock).
   - `packages/core/src/booking-amendments/get-effective-pricing-intent.integration.test.ts` (8 tests réels sans skip couvrant la résolution TIME_RANGE originale, DAY_RANGE originale, dernier amendement APPLIED, cohérence multi-lignes, fail-closed sur snapshot corrompu, dérivation legacy et isolation multi-tenant).
3. **Module booking-amendments complet** :
   - 18 fichiers de tests, 294 tests passés à 100% sans régression.
4. **Tests Web** :
   - `apps/web/src/lib/amendment-auth.test.ts` (6 tests auth).
   - `apps/web/src/app/actions/booking-amendments.test.ts` (11 tests action, dont 2 tests de sécurité d'absence de fuite d'UUIDs).
   - `apps/web/src/app/dashboard/[orgId]/operations/[bookingId]/amend/amend-booking.test.tsx` (16 tests pour le helper pur, le composant de présentation et la garde d'entrée).
   - Suite Web complète : 13 fichiers de tests, 238 tests passés.
5. **Vérification globale** :
   - `pnpm typecheck` : 100% vert sur les 8 packages/apps du monorepo.
   - `pnpm lint` : 100% vert (0 warning, 0 error).
   - `pnpm format:check` : 100% vert.
   - `pnpm --filter @uttily/web build` : 100% vert (Next.js 16.2.12).
