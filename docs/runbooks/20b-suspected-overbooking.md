# Runbook 20-B — Sur-réservation suspectée

## Symptôme

Deux réservations semblent occuper le même exemplaire ou un loueur signale un
stock impossible malgré l'interface.

## Diagnostic

Suspendre la remise de l'exemplaire concerné, consulter les réservations,
`inventory_blocks`, allocations et états de paiement dans Support, puis lire
`/internal/health`. Utiliser PostgreSQL comme autorité et vérifier les plages
customer/block, le type de bloc et les identifiants de source.

## Action sûre

Geler la décision opérationnelle pour l'exemplaire, conserver les lignes et
captures nécessaires, corriger uniquement via le use case autorisé après
analyse transactionnelle, et escalader les conflits. Rejouer une réconciliation
ou un worker seulement si l'événement et sa clé d'idempotence sont identifiés.

## Action interdite

Ne pas supprimer un bloc, convertir un hold en booking à la main, déplacer un
exemplaire dans la base ou confirmer une réservation pour résoudre l'affichage.

## Replay / recovery existant

Contraintes d'exclusion PostgreSQL sur les blocs actifs, allocation
transactionnelle, Support payments, expiration des holds et outbox avec
idempotence.

## Escalade

Escalader immédiatement au responsable opérations, Core et DB avec les IDs
techniques non sensibles, les plages horaires UTC et les deux réservations
concernées. La remise au client reste bloquée jusqu'à décision humaine.
