# Configuration Stripe TEST et test manuel E2E

Ce document décrit la configuration de l'environnement Stripe TEST et la
procédure de test manuel E2E (de bout en bout) avec une sandbox Stripe réelle.
Il complète le harness fake contractuel
(`apps/web/src/e2e/stripe-checkout-harness.test.ts`) qui valide le contrat entre
les composants **sans** appeler l'API Stripe réelle.

## Statut actuel

- **Tests automatisés (fake + PostgreSQL)** : ✅ validés — 800 tests core,
  115 tests web, 116 tests database, harness E2E fake contractuel.
- **Parcours Stripe TEST réel** : ⛔ bloqué — `apps/web/.env.local` existe mais
  ne contient aucune variable Stripe. Voir « Variables requises » ci-dessous
  pour la liste exacte des variables manquantes.

## Prérequis

1. Compte Stripe (sandbox / test mode) — https://dashboard.stripe.com/test.
2. Clés API TEST : `sk_test_...` (secret) et `pk_test_...` (publishable).
   Disponibles dans le dashboard Stripe → **Developers → API keys**.
3. Webhook secrets TEST : `whsec_...` (endpoint platform **et** endpoint
   Connect). Disponibles dans **Developers → Webhooks** après création des
   endpoints (voir « Création des endpoints webhook » ci-dessous).
4. Stripe CLI installée localement (pour forwarder les webhooks en local).
   - macOS : `brew install stripe/stripe-cli/stripe`.
   - Linux : voir https://github.com/stripe/stripe-cli/releases.
   - Authentification : `stripe login` (ouvre le navigateur).

## Variables requises

Le fichier `apps/web/.env.local` (non versionné) doit contenir les variables
suivantes. `pnpm dev` lance `next dev` depuis `apps/web/`, donc Next.js charge
`apps/web/.env.local`. **Aucune variable Stripe n'est actuellement configurée**
— créer/éditer le fichier `apps/web/.env.local` et les renseigner :

**Secrets à fournir (bloquants)** :

| Variable | Valeur attendue | Source |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | `sk_test_...` | Dashboard Stripe → API keys |
| `STRIPE_PLATFORM_WEBHOOK_SECRET` | `whsec_...` | Stripe CLI (au démarrage de `stripe listen`) ou Dashboard → Webhooks |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | `whsec_...` | Stripe CLI (au démarrage de `stripe listen`) ou Dashboard → Webhooks |

**Clé publishable (safe à exposer au client)** :

| Variable | Valeur attendue | Source |
| --- | --- | --- |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_test_...` | Dashboard Stripe → API keys |

**Constantes locales (pas des secrets)** :

| Variable | Valeur attendue | Note |
| --- | --- | --- |
| `STRIPE_ENVIRONMENT` | `TEST` | Fixe pour le test |
| `PAYMENTS_LIVE_ENABLED` | `false` | Verrou ADR-010 §4, JAMAIS true en test |

**Options facultatives (non bloquantes)** :

| Variable | Valeur attendue | Note |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | Si vide, validé contre le host de la requête |
| `SUPPORTED_STRIPE_COUNTRIES` | `FR,DE,ES,...` | Si vide, Stripe valide côté provider |

> `PAYMENTS_LIVE_ENABLED` doit rester `false` tant que les 6 verrous
> finance/juridique (ADR-010 §4) ne sont pas fermés. Un test ne peut **jamais**
> contourner ce verrou.

## Création du fichier .env.local

```bash
# pnpm dev lance next dev depuis apps/web/, donc Next.js charge apps/web/.env.local :
cp .env.example apps/web/.env.local
# Puis éditer apps/web/.env.local et renseigner les valeurs TEST ci-dessus.
# Ne JAMAIS committer apps/web/.env.local (il est dans .gitignore).
```

## Création des endpoints webhook (dashboard Stripe)

1. Aller dans **Developers → Webhooks → Add endpoint**.
2. Créer l'endpoint **platform** :
   - URL : `https://<votre-domaine>/api/webhooks/stripe/platform`
   - Événements (ADR-010 §9) :
     - `payment_intent.succeeded`
     - `payment_intent.processing`
     - `payment_intent.payment_failed`
     - `payment_intent.canceled`
     - `charge.refunded`
     - `refund.created`
     - `refund.updated`
     - `refund.failed`
   - Récupérer le `whsec_...` → `STRIPE_PLATFORM_WEBHOOK_SECRET`.
3. Créer l'endpoint **Connect** :
   - URL : `https://<votre-domaine>/api/webhooks/stripe/connect`
   - Événements : `account.updated`.
   - Récupérer le `whsec_...` → `STRIPE_CONNECT_WEBHOOK_SECRET`.

> En local, utiliser `stripe listen` (voir « Webhooks en local ») au lieu
> d'endpoints dashboard. Les secrets `whsec_...` du CLI sont affichés au
> démarrage de `stripe listen`.

## Test manuel E2E

### Étape 1 : Démarrer l'application

```bash
pnpm dev
```

### Étape 2 : Onboarding Stripe Connect (dashboard loueur)

1. Se connecter en tant que OWNER d'une organisation.
2. Aller dans **Paramètres > Paiements**.
3. Cliquer **« Configurer Stripe »**.
4. Suivre l'onboarding Stripe-hosted (utiliser les données de test Stripe).
5. Revenir au dashboard — le statut doit être **« Compte actif »**.

### Étape 3 : Créer un brouillon de réservation

1. Naviguer vers le catalogue public.
2. Sélectionner un équipement, des dates, une quantité.
3. Créer un brouillon (hold).

### Étape 4 : Paiement (checkout)

1. Aller sur `/checkout/[draftId]`.
2. Cliquer **« Payer »**.
3. Remplir la carte de test Stripe : `4242 4242 4242 4242`.
4. Confirmer le paiement.
5. Vérifier **« Paiement soumis »**.

### Étape 5 : Vérifier la confirmation

1. Le webhook `payment_intent.succeeded` doit être reçu et traité.
2. Vérifier en DB (une seule transaction atomique, ADR-010 §10) :
   - `bookings.status = CONFIRMED` ;
   - `booking_drafts.status = CONVERTED` ;
   - `payments.status = SUCCEEDED` et `payment_attempts.status = SUCCEEDED` ;
   - holds `CONVERTED` et allocations `CONVERTED` ;
   - nouveaux blocs `BOOKING/ACTIVE` créés avec `source_id = booking.id` ;
   - événement `BOOKING_CONFIRMED.v1` présent dans `outbox_events`.
3. Le dashboard doit afficher la réservation.

### Étape 6 : Vérifier les cas d'échec et d'abandon

- **Paiement échoué** (`payment_intent.payment_failed`) : le paiement et la
  tentative passent en `REQUIRES_PAYMENT_METHOD`. Le hold est **conservé** pour
  permettre une nouvelle tentative avec une autre méthode de paiement
  (ADR-010 §11).
- **Paiement annulé** (`payment_intent.canceled`) : le brouillon passe en
  `CANCELLED`, les holds en `RELEASED` et les allocations en `RELEASED`.
- **Fermeture du navigateur** : une fermeture du navigateur n'est **pas** une
  preuve d'abandon. L'expiration du hold et la réconciliation déterminent la
  libération d'un paiement ambigu (ADR-010 §11-12).
- **Paiement ambigu** (erreur réseau, statut incertain) : la réconciliation
  périodique interroge Stripe, applique le résultat et libère uniquement après
  constat du statut `canceled`. Jamais de libération aveugle.

## Cartes de test Stripe

| Carte | Comportement |
| --- | --- |
| `4242 4242 4242 4242` | Paiement réussi |
| `4000 0025 0000 3155` | Requiert 3DS (SCA) |
| `4000 0000 0000 0002` | Carte refusée |

## Webhooks en local

La Stripe CLI utilise une **seule** commande `stripe listen` avec deux flags
distincts pour forwarder les événements snapshot et Connect vers deux endpoints
différents (source : https://docs.stripe.com/cli/listen,
https://github.com/stripe/stripe-cli/wiki/Listen-command) :

- `--forward-to` : forward les événements snapshot (PaymentIntent, Charge,
  Refund) vers l'endpoint Platform ;
- `--forward-connect-to` : forward les événements Connect (account.updated) vers
  l'endpoint Connect ;
- `--events` : filtre les événements snapshot à écouter (liste séparée par des
  virgules). `account.updated` est un événement snapshot et doit être inclus
  explicitement pour que la projection de readiness du compte connecté
  fonctionne en local.

```bash
stripe listen \
  --forward-to localhost:3000/api/webhooks/stripe/platform \
  --forward-connect-to localhost:3000/api/webhooks/stripe/connect \
  --events payment_intent.succeeded,payment_intent.processing,payment_intent.payment_failed,payment_intent.canceled,charge.refunded,refund.created,refund.updated,refund.failed,account.updated
```

### Secret de signature en local

La documentation officielle Stripe décrit un **unique** secret de signature
affiché au démarrage de `stripe listen` (ex. `> Ready! Your webhook signing
secret is whsec_...`). Le flag `--forward-connect-to` ne documente pas la
génération d'un second secret : les événements Platform et Connect forwardés
par la même session CLI sont signés avec ce secret unique.

Les deux routes webhook Uttily (`/api/webhooks/stripe/platform` et
`/api/webhooks/stripe/connect`) vérifient séparément leur variable
d'environnement (`STRIPE_PLATFORM_WEBHOOK_SECRET` et
`STRIPE_CONNECT_WEBHOOK_SECRET` respectivement, via
`StripeAdapter.resolveWebhookSecret`). En local avec une seule session CLI,
renseigner le **même** secret dans les deux variables :

- `STRIPE_PLATFORM_WEBHOOK_SECRET` = secret affiché par `stripe listen` ;
- `STRIPE_CONNECT_WEBHOOK_SECRET` = secret affiché par `stripe listen` (même
  valeur).

### Secrets de signature via Dashboard Stripe

Avec deux endpoints créés dans le Dashboard Stripe (section « Création des
endpoints webhook » ci-dessus), chaque endpoint possède son **propre** secret
`whsec_...`. Renseigner alors les deux secrets distincts :

- `STRIPE_PLATFORM_WEBHOOK_SECRET` = secret de l'endpoint Platform ;
- `STRIPE_CONNECT_WEBHOOK_SECRET` = secret de l'endpoint Connect.

## Vérifications post-test

- Aucun `client_secret` dans les logs ou la DB.
- Aucun numéro de carte dans la DB.
- `payments.environment = 'TEST'`.
- `PAYMENTS_LIVE_ENABLED` reste `false`.
- Vérifier que `STRIPE_WEBHOOK_IP_ALLOWLIST` est configuré en LIVE (fail-closed).
- Vérifier que `STRIPE_WEBHOOK_RATE_LIMIT_VERIFIED=true` en LIVE (fail-closed).
