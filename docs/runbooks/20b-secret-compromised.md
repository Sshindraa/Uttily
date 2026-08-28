# Runbook 20-B — Secret compromis

## Symptôme

Un secret apparaît dans un log/ticket, une machine non autorisée, un dépôt, ou
une activité provider indique une utilisation inattendue.

## Diagnostic

Identifier exactement la variable et l'environnement exposés, préserver les
preuves minimales, rechercher les usages anormaux chez le provider et vérifier
les logs sans recopier la valeur. Classer séparément clé Stripe, webhook,
cron, Clerk, R2, Resend ou curseur public.

## Action sûre

Suivre la procédure de rotation de `chantier-20b-recovery.md`, révoquer l'ancien
secret selon la fenêtre de coexistence réellement supportée, redéployer les
consommateurs et vérifier `/internal/health`, webhooks et crons. Si nécessaire,
mettre temporairement en pause l'action concernée avec l'autorité du
responsable.

## Action interdite

Ne pas publier la valeur dans un ticket, ne pas la tester dans une commande
historisée, ne pas désactiver les contrôles de signature et ne pas révoquer une
clé avant d'avoir identifié ses consommateurs et le plan de bascule.

## Replay / recovery existant

Rotation provider, déduplication des événements Stripe, réconciliation
idempotente, cron authentifié par secret et leases/fencing outbox.

## Escalade

Escalader immédiatement au security owner, au propriétaire de l'environnement
et au provider concerné. En cas de Stripe/Clerk, faire invalider la valeur dans
le dashboard provider et consigner seulement les métadonnées non sensibles.
