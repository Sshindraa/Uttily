# Runbook 20-B — Webhook Stripe en panne

## Symptôme

Les événements Stripe n'arrivent plus, retournent une erreur HTTP, ou restent
non traités ; un paiement peut rester dans une attente anormale.

## Diagnostic

Consulter `/internal/health`, les logs structurés des routes
`/api/webhooks/stripe/platform` et `/api/webhooks/stripe/connect`, puis le
dashboard Stripe pour distinguer livraison, signature, disponibilité DB et
traitement applicatif. Vérifier l'environnement TEST/LIVE et la présence du
secret correspondant sans l'afficher.

## Action sûre

Corriger la cause d'infrastructure ou de configuration, puis demander/rejouer
les événements concernés depuis le mécanisme Stripe autorisé. Laisser la
déduplication `provider_event_id` et les transitions transactionnelles décider
du résultat. Pour un paiement déjà connu, utiliser ensuite la réconciliation
existante.

## Action interdite

Ne pas marquer manuellement un paiement comme réussi, ne pas créer une seconde
clé d'idempotence et ne pas désactiver la vérification de signature ou
d'environnement.

## Replay / recovery existant

Routes webhook Stripe platform/connect, table d'événements provider avec
identifiant idempotent, `GET /api/cron/reconcile-payments` et Support
`reconcilePaymentSupport`.

## Escalade

Escalader au responsable paiements, au propriétaire de l'application et à
Stripe si la livraison provider reste en échec ou si un événement a un résultat
ambigu. Noter les identifiants d'événements, sans payload secret.
