# G7M-C3 — Webhook et application atomique du supplément

## État

Le chemin Core C3 est implémenté localement au-dessus de G7M-C2. Le commit C3
initial existe déjà ; les corrections et preuves PostgreSQL ajoutées dans cette
revue restent locales et non commitées. Les suites ciblées unitaires, statiques
et PostgreSQL réelles sont vertes. La validation Core globale reste pending CI.

G7M-C4 (expiration et compensation tardive) et G7M-C5 (route cliente et
Stripe Elements) restent hors périmètre.

## Comportement livré

- `handleWebhook` distingue les PaymentIntents `AMENDMENT` des paiements
  initiaux sans modifier le flux legacy.
- La résolution utilise d’abord `provider_payment_intent_id` et peut retomber
  sur `amendment_payment_attempt_id` lorsque le webhook précède la Transaction B
  de C2.
- La transaction métier verrouille l’organisation, la réservation, l’amendement,
  les blocks, les allocations, les segments, le paiement, l’attempt puis
  l’événement webhook en dernier.
- `payment_intent.succeeded` valide les metadata exactes, le customer, le tenant,
  l’environnement, le montant, la devise, la destination, la commission et
  `on_behalf_of`, puis convertit les holds, conserve les blocks source pour
  `RETAIN`, remplace ceux de `REPLACE`, crée les blocks `BOOKING` nécessaires,
  applique l’amendement et publie `BOOKING_AMENDED.v1` atomiquement.
- Les événements `requires_action`, `processing`, `payment_failed` et `canceled`
  projettent les états de paiement de supplément de manière monotone. Un état
  terminal local n’est jamais régressé par un événement livré en désordre ; un
  échec conserve l’amendement `HOLD_PENDING` et ses holds.
- Un succès reçu après le `holdDeadline` est projeté sur le paiement sans
  appliquer l’amendement et retourne un résultat interne
  `LATE_SUCCESS_REQUIRES_COMPENSATION` ; l’expiration et la compensation sont
  réservées à C4.
- Aucun appel provider n’est effectué dans le webhook handler et aucun
  `clientSecret` n’est persisté, loggé ou placé dans l’outbox.
- Les collisions d’outbox avec payload incompatible échouent de façon fail-closed
  et roulent la transaction ; les logs de succès tardif et de résolution
  infructueuse n’exposent aucun identifiant de fixture ou provider.

## Vérifications locales

- typecheck Core : vert ;
- lint des fichiers C3 : vert ;
- Prettier ciblé : vert ;
- `git diff --check` : vert ;
- `apply-supplement-amendment.integration.test.ts` : 12/12 tests PostgreSQL
  réels, 0 skip ;
- `handle-webhook.integration.test.ts` : 93/93 tests PostgreSQL réels, 0 skip ;
- unitaires ciblés : projection C3 10/10, `handleWebhook` 34/34, metadata
  8/8, commission 7/7, delta-segments 4/4 ; adapters Fake/Stripe 172/172 ;
- régression complète `booking-amendments` : 213/213 (121 unitaires,
  92 PostgreSQL), 0 skip ; `get-effective-booking` : 34/34 ;
- C2 `initiateSupplementPayment` : 13/13 tests PostgreSQL réels ;
- le correctif de collision JSONB d’outbox et l’assainissement des logs sont
  locaux, sans nouveau commit, staging, push ou PR ;
- C4 (expiration/compensation), C5 (UI) et la validation Core globale restent
  pending CI.
