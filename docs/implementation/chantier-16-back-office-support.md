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
