# Runbook 20-B — Déploiement Vercel cassé

## Symptôme

Le dernier déploiement renvoie des 5xx, casse une route, ou devient
incompatible avec le schéma après migration.

## Diagnostic

Comparer le déploiement courant au dernier connu bon, lire les logs Vercel et
`/internal/health`, vérifier les variables présentes et la migration déjà
appliquée. Identifier si le défaut est applicatif, configuration, provider ou
incompatibilité de contrat.

## Action sûre

Promouvoir via Vercel le dernier déploiement connu compatible avec le schéma
courant, puis vérifier `/internal/health`, checkout, Support et crons. Si une
migration est en cause, arrêter les nouvelles écritures sensibles et préparer
une correction forward validée.

## Action interdite

Ne pas réécrire l'historique Drizzle, supprimer des colonnes à la main ou
restaurer une base sur la cible active sans plan validé et checkpoint.

## Replay / recovery existant

Historique des déploiements Vercel, rollback applicatif, migrations Drizzle
versionnées, health interne et réconciliation/outbox idempotents.

## Escalade

Escalader au propriétaire Web et au responsable DB si le rollback de code n'est
pas compatible avec le schéma, ou si l'incident touche paiement, réservation ou
inventaire.
