# Runbook 20-B — Paiement réussi, réservation non confirmée

## Symptôme

Stripe indique un paiement réussi mais la réservation Uttily n'est pas
`CONFIRMED`, ou le client reste bloqué après paiement.

## Diagnostic

Dans `/internal/payments`, retrouver le paiement et sa tentative ; comparer
l'état local, l'événement Stripe et les logs webhook. Lire `/internal/health` et
vérifier les leases/outbox. Confirmer que l'organisation, le draft et les
blocs d'inventaire correspondent, sans modifier leur état.

## Action sûre

Lancer l'action Support de réconciliation avec un motif précis si elle est
éligible, puis laisser le cron `GET /api/cron/reconcile-payments` reprendre les
tentatives selon les leases et l'idempotence. Vérifier ensuite la réservation,
les blocs et l'outbox.

## Action interdite

Ne pas éditer directement `payments.status`, `bookings.status` ou les blocs,
ne pas créer une nouvelle réservation et ne pas relancer Stripe avec une clé
d'idempotence différente.

## Replay / recovery existant

`reconcilePaymentSupport`, `/api/cron/reconcile-payments`, les clés provider
d'idempotence, la transaction de confirmation et l'outbox de réservation.

## Escalade

Escalader au responsable paiements si le provider est réussi mais la
réconciliation refuse l'action, si le hold est expiré, ou si l'inventaire ne
permet plus une confirmation sûre.
