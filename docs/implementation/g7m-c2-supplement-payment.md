# G7M-C2 — Initiation du paiement du supplément

- **Statut** : implémenté — validation ciblée PostgreSQL et régressions ciblées vertes ; validation Core globale pending CI
- **ADR de référence** : [ADR-023](../decisions/ADR-023-booking-financial-amendments.md), §§8, 10, 12 et 15
- **Migration** : aucune ; le schéma 0036 et ses transitions existantes sont suffisants

## Périmètre livré

`initiateSupplementPayment` prend un amendement `SUPPLEMENT/HOLD_PENDING` créé
par G7M-C1 et orchestre deux transactions locales séparées par un appel
Stripe :

1. Transaction A capture `startedAt`, verrouille dans l'ordre organisation →
   réservation → amendement → paiement → tentative, vérifie le tenant, le
   client, l'environnement, le hold et les snapshots, puis passe le paiement
   et la tentative en `PROCESSING`. La deadline est exactement le minimum entre
   `startedAt + 30 minutes` et `hold_deadline`, et reste strictement postérieure
   à `startedAt`.
2. Après commit de A, l'adapter crée ou relit le PaymentIntent avec la même
   `provider_idempotency_key` et le snapshot financier autoritaire.
3. Transaction B capture un nouvel instant `projectionAt`, reprend les mêmes
   verrous et vérifie d'abord le hold. Si `projectionAt >= hold_deadline`, elle
   retourne `HOLD_EXPIRED` sans projeter l'intent ou son statut ; l'état local
   reste récupérable avec la même clé d'idempotence. Sinon elle projette
   uniquement `providerPaymentIntentId` et `providerStatus` sur l'attempt. Le
   `clientSecret` est retourné uniquement en mémoire après le commit de B ; il
   n'est ni persisté, ni placé dans l'outbox, ni journalisé.

La concurrence est gérée par les verrous PostgreSQL et la tentative logique
unique héritée de C1. Un appel concurrent qui rencontre un traitement actif
retourne `IN_PROGRESS`. Un replay avec un PaymentIntent déjà connu utilise
`retrievePaymentIntent` ; aucune nouvelle tentative n'est créée. Les erreurs
fournisseur et les incohérences de projection sont explicites et laissent une
un état local récupérable. C2 ne traite ni webhook, ni application atomique, ni
compensation C4, ni UI.

## Commission

Pour un supplément legacy, la commission historique est calculée en unités
mineures avec arrondi half-up positif :

```text
round_half_up(supplement * commission_original / total_original)
```

Le calcul utilise `bigint`, est borné entre zéro et le supplément et reprend
les montants originaux depuis `bookings` et le supplément depuis
`amendment_payments`. Le cas `total_original = 0` est accepté uniquement avec
une commission originale nulle. Le montant calculé est envoyé dans
`application_fee_amount` et n'est jamais recalculé depuis le client.

Pour un booking `split-13-7-v1`, ce calcul legacy n'est pas utilisé : le
supplément conserve un snapshot `FINAL_STATE_DELTA_PER_COMPONENT` sous la règle
du booking d'origine. L'application fee provider est la somme des deltas
loueur et service client ; un delta négatif reste bloqué tant que la politique
refund Finance/Juridique n'est pas signée.

## Preuve

- commission : 7 tests unitaires, dont zéro, proportion exacte, tie half-up,
  borne, grandes valeurs sûres et total nul cohérent/incohérent ;
- metadata : 8 tests dédiés Fake, plus la validation équivalente dans le test
  Stripe (inclus dans les 82 tests de l'adapter), soit 90 tests Fake/Stripe
  exécutés ; le contrat rejette payment type inconnu, UUID/env/protocole
  amendment invalides et champ supplémentaire initial, tout en conservant les
  metadata historiques valides ;
- PostgreSQL réel : 13/13 tests C2 couvrant paramètres et commission exacts,
  deadline exacte bornée par le hold, absence de fuite du secret, holds/
  allocations/segments inchangés, isolation client/tenant/environnement,
  expiration pendant l'appel provider, erreur provider récupérable, réponse
  `succeeded` synchrone non terminale localement, LIVE, six mismatches séparés,
  concurrence, replay retrieve et course terminale ;
- timeout audit `get-effective-booking` : test 25 isolé 1/1, test 31 isolé
  1/1, fichier complet 34/34. Les deux timeouts historiques observés sous
  charge du module sont documentés comme intermittents ; ils n'ont pas été
  reproduits dans la validation actuelle, sans modification de timeout global ;
- module `booking-amendments` : 111/111 tests unitaires et 80/80 tests
  PostgreSQL d'intégration, soit 191/191 sur le périmètre module ;
- régressions : payment-initiation 56/56, adapters Fake/Stripe 172/172,
  lint, typecheck et build verts. La suite Core globale n'est pas revendiquée
  comme verte localement : son gate final reste pending CI.

Voir également [G7M-C1](g7m-c1-supplement-local.md) et l'ADR-023.
