# Runbook 20-B — Remboursement provider ambigu

## Symptôme

Une demande de remboursement est en attente alors que le provider ne permet pas
de déterminer immédiatement si l'opération a été créée, exécutée ou refusée.

## Diagnostic

Consulter `/internal/health`, le paiement et la demande dans Support, puis les
événements et l'état du remboursement côté provider. Vérifier la clé
`provider_idempotency_key`, le lease et les erreurs de réconciliation ; ne pas
conclure à partir d'un timeout seul.

## Action sûre

Conserver l'état en attente/revue manuelle prévu, rechercher l'événement provider
correspondant et reprendre le worker ou le cron existant une fois le résultat
établi. Consigner la décision et le lien vers l'événement provider.

## Action interdite

Ne pas lancer un second remboursement avec une nouvelle clé, ne pas passer la
demande à `COMPLETED` à la main et ne pas modifier le paiement initial pour
masquer l'incertitude.

## Replay / recovery existant

Outbox `REFUND_REQUESTED`, worker de compensation, `GET
/api/cron/process-refund-requests`, `GET /api/cron/process-compensations` et
les clés provider idempotentes.

## Escalade

Escalader à Finance et au responsable Stripe avec l'identifiant de demande, la
clé d'idempotence non secrète et l'identifiant d'événement provider. Escalader
au provider si son état reste indéterminable.
