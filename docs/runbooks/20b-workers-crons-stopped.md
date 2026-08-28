# Runbook 20-B — Workers ou crons arrêtés

## Symptôme

Les événements outbox, documents, emails, réconciliations ou expirations ne
progressent plus ; les routes cron répondent 401, 5xx ou ne sont plus appelées.

## Diagnostic

Lire `/internal/health` : outbox due, leases actives/expirées, notifications et
signaux de paiement. Vérifier les logs du worker et l'historique du scheduler,
puis distinguer secret invalide, DB indisponible et processus arrêté.

## Action sûre

Rétablir le worker/scheduler avec la configuration existante, ou déclencher
manuellement la route cron concernée avec `CRON_SECRET` depuis un opérateur
autorisé. Laisser le claim/reclaim et le fencing reprendre les leases expirées.

## Action interdite

Ne pas supprimer l'outbox, remettre globalement des états à zéro, augmenter les
tentatives à la main ou exécuter une route sans authentification.

## Replay / recovery existant

Routes `expire-holds`, `reconcile-payments`, `process-compensations`,
`process-refund-requests` et `process-product-analytics`, plus worker outbox,
sweeper/reclaim et clés d'idempotence.

## Escalade

Escalader au propriétaire runtime si deux cycles restent sans progression, si
les leases sont bloquées ou si les erreurs DB/provider persistent. Informer
Support si des réservations ou paiements sont concernés.
