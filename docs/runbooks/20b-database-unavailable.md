# Runbook 20-B — Base indisponible

## Symptôme

`/internal/health` échoue, les routes applicatives renvoient une erreur de
connexion ou les workers n'arrivent plus à lire/écrire PostgreSQL.

## Diagnostic

Confirmer l'erreur depuis un accès opérateur non destructif, vérifier les
limites de connexion et le statut du fournisseur, puis distinguer panne réseau,
pool saturé, migration en cours et incident PostgreSQL. Ne pas afficher l'URL
ou le mot de passe dans les tickets.

## Action sûre

Mettre en pause les actions opérateur qui écrivent, préserver les requêtes et
logs corrélés, puis suivre la procédure de disponibilité du provider. Après
retour, vérifier `/internal/health`, les migrations enregistrées, les leases et
relancer seulement les mécanismes idempotents concernés.

## Action interdite

Ne pas exécuter de migration improvisée, restaurer par-dessus une cible utilisée
par l'application, supprimer des connexions ou modifier les statuts métier pour
contourner la panne.

## Replay / recovery existant

`/internal/health`, checkpoints/restauration documentés par le provider,
transactions idempotentes, réconciliation paiement et reclaim outbox.

## Escalade

Escalader immédiatement à l'opérateur Neon/DB et au responsable runtime avec
l'heure UTC, l'impact et les erreurs sanitaires. Le RPO/RTO doit rester
`A_CONFIRMER` tant qu'aucun exercice autorisé ne l'a mesuré.
