# G7M-C3 — Webhook et application atomique du supplément

## État

Le chemin Core C3 est implémenté localement au-dessus de G7M-C2. La validation
unitaire et statique ciblée est verte ; la preuve PostgreSQL ciblée reste à
exécuter dans la CI ou avec un PostgreSQL de test disponible. Aucun service n’a
été démarré pendant cette phase.

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

## Vérifications locales

- typecheck Core : vert ;
- lint des fichiers C3 : vert ;
- Prettier ciblé : vert ;
- `git diff --check` : vert ;
- suites unitaires ciblées C3/webhook/metadata/commission : 59/59, dont 10/10
  tests de projection C3 ;
- suites PostgreSQL C3 : pending, PostgreSQL arrêté.
