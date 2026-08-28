# Chantier 20-A — LIVE Technical Readiness

Ce contrôle prépare un passage TEST/STAGING → LIVE sans activation Stripe LIVE,
transaction réelle, appel fournisseur payant ou écriture en base.

## Contrôle local

```bash
pnpm readiness:live
```

La commande lit uniquement l'environnement du processus et renvoie un rapport
composé de noms, descriptions et statuts. Elle ne renvoie jamais de valeur de
secret, n'écrit pas en base, ne crée pas de PaymentIntent et n'appelle aucun
provider.

La source unique des variables est
`packages/core/src/live-readiness/live-config.ts`.

## Variables REQUIRED_LIVE

- Stripe : `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`,
  `STRIPE_ENVIRONMENT`, `PAYMENTS_LIVE_ENABLED`, les deux secrets webhook,
  `STRIPE_WEBHOOK_IP_ALLOWLIST`, `STRIPE_WEBHOOK_RATE_LIMIT_VERIFIED`,
  `PLATFORM_COMMISSION_RATE_BPS`.
- Base : `DATABASE_URL` distant PostgreSQL (jamais localhost en LIVE).
- Auth : `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`,
  `INVITATION_SECRET`.
- Sécurité : `CRON_SECRET`, `PUBLIC_SEARCH_CURSOR_SECRET`.
- Application : `PUBLIC_APP_URL` HTTPS public.
- R2 : `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_BUCKET_NAME`.
- Email : `RESEND_API_KEY`, `RESEND_FROM_EMAIL`,
  `RESEND_BOOKING_CONFIRMED_TEMPLATE_ID`.

Les clés `NEXT_PUBLIC_*` ne sont pas des secrets, mais elles restent requises
pour prouver la cohérence du couple public/secret LIVE. Les valeurs réellement
optionnelles restent dans `OPTIONAL_VARIABLES`.

## Preuves d'isolement

- Les préfixes `sk_test_`/`sk_live_` et `pk_test_`/`pk_live_` sont contrôlés
  avant usage ; `STRIPE_ENVIRONMENT` et `PAYMENTS_LIVE_ENABLED` sont explicites.
- L'adaptateur Stripe vérifie `livemode` sur les PaymentIntents et événements
  webhook, et lorsqu'il est présent sur les refunds. Un objet signé provenant
  de l'autre mode est rejeté.
- Les secrets platform et Connect sont distincts et sélectionnés par endpoint.
  Le mode d'un `whsec_...` n'est pas déductible de son préfixe : la preuve de
  mode vient de la vérification de signature avec le secret de l'endpoint puis
  de `event.livemode`.
- Les mutations et traitements serveur réutilisent les contrôles existants :
  environnement de l'adaptateur et de l'entrée, compte Connect de
  l'organisation, `payments.environment`, tentative, draft et filtres
  d'environnement des crons de réconciliation, refunds et compensations.
- Toute incohérence ou absence requise est bloquante ; aucun fallback TEST ↔
  LIVE n'est utilisé par `readiness:live`.

## Gates produit conservés

Le contrôle ne contourne aucun gate existant : activation pays/Connect,
activation Stripe LIVE, publication publique, authentification des routes
internes et configuration de production restent nécessaires. L'analytics
`PRODUCT_ANALYTICS_ENVIRONMENT=PRODUCTION` reste verrouillé jusqu'au sign-off
privacy APPROVED du Chantier 20-C ; le readiness report le marque en échec et
le runtime existant le résout en `DISABLED`.

## Actions manuelles hors code

À effectuer séparément par les responsables habilités, sans être exécutées par
ce chantier : créer les variables LIVE dans le gestionnaire de secrets,
vérifier les deux endpoints Stripe et leurs secrets dans le même compte LIVE,
configurer l'allow-list/rate-limit webhook, confirmer le compte Connect et les
pays activés, puis configurer Vercel/Neon/R2/Resend. Une transaction réelle,
l'activation `PAYMENTS_LIVE_ENABLED=true` et la publication finale restent hors
du périmètre 20-A.
