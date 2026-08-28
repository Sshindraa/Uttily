# Chantier 16 — Back-office Uttily & Support V1

## Contexte & Périmètre

Le Chantier 16 met en place le **back-office interne Uttily V1** indispensable pour opérer, diagnostiquer et supporter un pilote réel sans jamais intervenir directement en base de données.

Ce back-office est strictement réservé à l'équipe **Uttily** (`is_platform_admin = true`). Il ne s'agit ni d'une deuxième application métier complète, ni d'un éditeur générique de base de données.

---

## 1. Décisions d'Architecture

- **ADR-028** : [`docs/decisions/ADR-028-back-office-uttily-and-support-v1.md`](../decisions/ADR-028-back-office-uttily-and-support-v1.md).
- **Séparation des espaces** : Zone `/internal` isolée de l'espace pro `/dashboard`.
- **Fail-closed** : Toute requête vers `/internal` ou les Server Actions support exige un compte utilisateur avec `is_platform_admin = true`.
- **Zéro fuite de secrets** : Aucun jeton d'invitation ou secret n'est exposé.
- **Actions support autorisées** :
  1. `retryNotificationSupport` (replanifie une notification échouée sans régénération de jeton).
  2. `cancelNotificationSupport` (annule une notification).
  3. `resendInvitationNotificationSupport` (recrée la notification d'invitation sans régénérer de hash secret).
  4. `reconcilePaymentSupport` (programme une réconciliation asynchrone par le worker).

---

## 2. Structure des Fichiers

```
packages/core/src/support/
├── types.ts                                    # Modèles et interfaces Support V1
├── search.ts                                   # Moteur de recherche multi-entités tolérant
├── organization-support.ts                     # Diagnostic 360° organisation & Stripe Connect
├── booking-support.ts                          # Diagnostic réservation, timeline et vérité financière
├── payment-support.ts                          # Diagnostics paiements, remboursements & erreurs
├── notification-support.ts                     # Listing sécurisé des notifications
├── audit-support.ts                            # Consultation du journal d'audit
├── actions/
│   ├── retry-notification.ts
│   ├── cancel-notification.ts
│   ├── resend-invitation-notification.ts
│   └── reconcile-payment.ts
└── support.integration.test.ts                 # Tests d'intégration PostgreSQL

apps/web/src/
├── lib/
│   ├── support-auth.ts                         # Guard fail-closed requireSupportPlatformAdmin
│   └── support-auth.test.ts
├── app/actions/
│   ├── support.ts                              # Server Actions support
│   └── support.test.ts
├── app/internal/
│   ├── layout.tsx & layout.module.css
│   ├── page.tsx & search-client.tsx & internal.module.css
│   ├── security-guardrails.test.ts             # Tests de sécurité et guardrails
│   ├── organizations/[orgId]/
│   │   ├── page.tsx
│   │   ├── resend-invitation-button.tsx
│   │   └── organization-support.module.css
│   ├── bookings/[bookingId]/
│   │   ├── page.tsx
│   │   ├── retry-notification-button.tsx
│   │   └── booking-support.module.css
│   ├── payments/
│   │   ├── page.tsx
│   │   ├── reconcile-payment-button.tsx
│   │   └── payments-support.module.css
│   ├── notifications/
│   │   ├── page.tsx
│   │   ├── notifications-client.tsx
│   │   └── notifications-support.module.css
│   └── audit/
│       ├── page.tsx
│       └── audit-support.module.css
└── app/admin/route.ts                          # Redirection vers /internal
```

---

## 3. Validation

- `pnpm check:fast` : 100% vert (typecheck monorepo + 2288 tests unitaires).
- Tests d'intégration PostgreSQL (`support.integration.test.ts`) : 6/6 tests passés.
- `pnpm --filter web build` : Build de production Next.js validé.

---

## 4. Chantier 16.1.1 — End-to-End Idempotency & Lease Fencing

> Durcissement du 2026-08-28, exécuté au-dessus de `928f6ade` (16.1). Aucun
> changement de schéma, aucune migration. Deux invariants prouvés de bout en bout.

### 4.1 Idempotence réelle du renvoi d'invitation

Chaîne complète UI → Server Action → Core :

- **UI** (`resend-invitation-button.tsx`) : le client crée un UUID stable pour
  UNE intention de renvoi (`useRef`). Le même UUID est réutilisé si la même
  soumission est rejouée après timeout/échec réseau ; il est renouvelé après un
  succès (le clic suivant exprime une nouvelle intention ⇒ nouvelle notification).
- **Server Action** (`resendInvitationNotificationAction`) : accepte un troisième
  argument obligatoire `supportRequestId`, le transmet intégralement au Core
  (preuve par test), et refuse fail-closed une absence sans jamais appeler le Core.
- **Core** (`resendInvitationNotificationSupport`) : `supportRequestId` est
  OBLIGATOIRE et validé au format UUID. Le Core refuse un requestId vide, espacé
  ou non-UUID (`SUPPORT_ACTION_INVALID_STATE`) et n'applique AUCUN fallback
  silencieux `randomUUID()`.
- Invariants prouvés sur PostgreSQL : même `invitationId + supportRequestId`
  ⇒ même notification et UN SEUL audit `SUPPORT_INVITATION_NOTIFICATION_RESEND`
  (aucun nouvel audit au replay) ; nouveau requestId ⇒ nouvelle notification et
  un audit supplémentaire.

### 4.2 Fencing du lease de réconciliation paiement

`reconcilePaymentSupport` ne vole jamais le lease d'un worker en vol :

- Seules les tentatives non-terminales avec
  `reconcile_lease_until IS NULL OR reconcile_lease_until <= transaction_timestamp()`
  sont sélectionnées (`FOR UPDATE` conservé). L'éligibilité est décidée par
  l'horloge PostgreSQL, jamais par l'horloge JS.
- Une tentative sous lease actif n'est jamais modifiée : ni `reconcile_lease_token`,
  ni `reconcile_lease_until`, ni `reconcile_after`. Si aucune autre tentative du
  paiement n'est éligible, l'action est refusée avec `SUPPORT_ACTION_INVALID_STATE`
  et aucun audit mensonger n'est écrit.
- Preuves PostgreSQL : (A) lease futur + token ⇒ refus, état strictement inchangé,
  zéro audit ; (B) lease expiré ⇒ réconciliation réussie, ancien lease nettoyé,
  tentative immédiatement due, audit présent ; (C) sans lease ⇒ comportement nominal.
- Preuve de rollback : violation FK déterministe sur l'écriture d'audit
  (`actor_user_id` inexistant) à l'intérieur de la transaction ⇒ échec de
  `reconcilePaymentSupport` et, après rollback, `reconcile_after`, lease, token
  et `updated_at` exactement dans leur état initial, zéro audit résiduel.

### 4.3 Politique fermée de relance manuelle (V1)

`validateManualNotificationRetry` est une allowlist fermée (fini le « tout
FAILED sauf un code ») :

- `INVALID_REQUEST` / erreur déterministe provider ⇒ refus manuel
  (`DETERMINISTIC_FAILURE_NO_RETRY`) : répéter la même requête ne corrige pas la cause.
- `PROVIDER_RESULT_UNCERTAIN_WINDOW_EXPIRED` ⇒ refus strict (anti-doublon).
- `MAX_RETRIES_EXCEEDED` ⇒ décision explicite via `providerFirstAttemptStartedAt`
  et la fenêtre d'idempotence provider : fenêtre dépassée ou indéterminable ⇒
  refus fail-closed (`MAX_RETRIES_IDEMPOTENCY_WINDOW_EXPIRED` /
  `MAX_RETRIES_WINDOW_UNDETERMINABLE`) ; encore dans la fenêtre sûre ⇒ relance
  autorisée avec motif obligatoire (imposé par `retryNotificationSupport`).
- Tout autre code FAILED (inconnu, legacy, brut, absent) ⇒ refus fail-closed
  (`FAILURE_CODE_FAIL_CLOSED`).

La durée de fenêtre d'idempotence provider (24 h) est factorisée dans une source
unique partagée par le moteur de notifications et la politique de relance :
`packages/core/src/notifications/provider-idempotency-window.ts`
(`RESEND_IDEMPOTENCY_WINDOW_MS`, `isProviderIdempotencyWindowExpired`). Le cutoff
23 h de la pipeline transactional-email (G5H-C1) reste un choix documenté distinct.

### 4.4 Validation 16.1.1

- PostgreSQL réel : `support.integration.test.ts` 12/12 (dont 4 nouveaux),
  `notifications.integration.test.ts` et `reconcile-payments-batch.integration.test.ts` verts.
- Tests Server Action : `support.test.ts` prouve que le `supportRequestId` reçu
  est transmis tel quel au Core, et qu'une absence est refusée sans appel Core.
- `pnpm check:fast`, lint, format, `pnpm --filter web build` : verts.
