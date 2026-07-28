# Réservations et disponibilité

## Principe

PostgreSQL est l'autorité finale. Une lecture peut être mise en cache, mais seule une transaction PostgreSQL décide qu'un exemplaire est libre et crée son blocage.

## Produit et exemplaire

```text
Produit : Paddle Aqua Marina 10'4
Exemplaires : PAD-001, PAD-002, PAD-003
```

Le produit est commercial. L'exemplaire est l'objet physique réellement réservé, entretenu et rendu.

## Périodes

Chaque location garde deux intervalles :

```text
customer_start_at / customer_end_at  : période vendue au client
blocked_start_at / blocked_end_at    : période réellement indisponible
```

La période bloquée inclut la préparation, le contrôle, le nettoyage et une éventuelle marge opérationnelle.

## Blocages d'inventaire

Une table conceptuelle unique représente les périodes indisponibles :

```text
InventoryBlock
- inventory_item_id
- type: HOLD | BOOKING | MAINTENANCE | MANUAL_BLOCK
- blocked_period
- status: ACTIVE | PAYMENT_PROCESSING | CONVERTED | RELEASED | EXPIRED
- expires_at (uniquement pour HOLD)
- source_id
```

Une contrainte d'exclusion PostgreSQL interdit le chevauchement de deux blocs actifs incompatibles pour un même `inventory_item_id`. La maintenance est donc protégée par la même règle que les réservations.

Un bloc soft-deleted (`deleted_at` non null) ne bloque plus : il est exclu de la contrainte d'exclusion et de la recherche de disponibilité. Le soft-delete sert à corriger une erreur de saisie sans perdre l'historique, tout en libérant immédiatement l'exemplaire.

## Flux de réservation

1. Le client demande une disponibilité.
2. Uttily attribue immédiatement les exemplaires dans une transaction.
3. Uttily crée un `HOLD` actif, expirant en général après dix minutes.
4. Uttily crée ou réutilise le paiement avec une clé d'idempotence.
5. Le webhook de paiement est la source de vérité.
6. En transaction, un paiement réussi convertit le hold en réservation confirmée.
7. Un événement est écrit dans l'outbox : confirmation, contrat et notification sont traités par le worker.

Un worker expire les holds abandonnés. Il ne libère pas un hold dont le paiement est encore en traitement sans vérifier l'état réel du paiement.

## États d'une réservation

```text
DRAFT
→ HELD
→ PAYMENT_PENDING
→ CONFIRMED
→ READY_FOR_PICKUP
→ ACTIVE
→ RETURNED
→ CLOSED

HELD / PAYMENT_PENDING → EXPIRED | CANCELLED
CONFIRMED → CANCELLED | REFUNDED
```

Les transitions sont validées par le domaine, jamais seulement par l'interface.

## Limites du MVP

- Un panier correspond à une organisation et un établissement de retrait.
- Les exemplaires sont attribués dès le hold.
- Les moyens de paiement différés sont reportés.
- Une caution est une stratégie distincte du paiement de location.
