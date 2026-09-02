# ADR-038 — Préparation des blocages manuels récurrents

**Statut :** Proposed — contrat à confirmer avant implémentation.

**Date :** 2026-09-02

**Relie à :** [ADR-035](ADR-035-closed-outdoor-equipment-taxonomy.md),
aux lots 21-U2-V et 21-U2-W, et à
[l'architecture de disponibilité](../architecture/booking-and-availability.md).

## Contexte

Uttily sait créer, libérer et afficher un blocage manuel ponctuel (`MANUAL_BLOCK`)
sur un exemplaire. Les loueurs ont aussi besoin de fermetures répétitives
(entretien hebdomadaire, fermeture récurrente d'un établissement, créneau
opérationnel réservé). Une récurrence mal bornée pourrait toutefois créer des
chevauchements silencieux, interpréter différemment les changements d'heure ou
modifier des réservations déjà confirmées.

Cette ADR prépare le contrat sans ajouter de schéma, de migration, d'interface
ou de récurrence exécutable.

## Décision proposée

La récurrence serait un agrégat de planification distinct, rattaché à une
organisation, un établissement et un exemplaire. Elle ne remplacerait jamais
les lignes `InventoryBlock` : les occurrences matérialisées resteraient
`MANUAL_BLOCK`, et PostgreSQL resterait l'autorité de disponibilité.

Le contrat recommandé est le suivant :

- une série possède une règle locale, un fuseau IANA explicite, une date de
  début et une borne de fin obligatoire ; aucune série infinie ;
- la V1 est limitée à un exemplaire et à une périodicité hebdomadaire ; pas de
  RRULE mensuelle, d'exception ou de série multi-exemplaires avant une décision
  dédiée ;
- les heures sont des heures murales du fuseau de l'établissement. Une heure
  inexistante ou ambiguë lors d'un changement DST est refusée, jamais devinée ;
- la création et toute modification calculent d'abord toutes les occurrences
  de la fenêtre, vérifient les conflits et n'écrivent rien si une occurrence
  chevauche une réservation, un hold, une maintenance ou un blocage incompatible ;
- une modification ne réécrit pas les occurrences déjà créées. Elle ne concerne
  que les occurrences futures qui n'ont pas commencé ; les occurrences
  existantes restent auditables ;
- suspendre une série empêche les occurrences futures, sans libérer
  silencieusement les occurrences déjà matérialisées. Libérer ou supprimer une
  occurrence reste une action explicite et idempotente ;
- créer, modifier, suspendre et supprimer exigent une autorisation serveur,
  l'isolation tenant et une clé d'idempotence. Aucun traitement côté interface
  ne peut contourner les contraintes PostgreSQL.

## Hors périmètre de cette préparation

- aucune table, migration, action serveur, cron, worker ou écran ;
- aucune modification du blocage ponctuel, de la recherche, du paiement, des
  réservations ou de l'une des huit familles actives ;
- aucune génération silencieuse d'un horizon non borné ;
- aucun conflit résolu automatiquement en déplaçant une réservation ou une
  maintenance.

## Questions à confirmer avant le lot d'implémentation

Le porteur produit doit confirmer la borne maximale de la série, les rôles
autorisés, la politique de modification lorsqu'une occurrence future est déjà
réservée, et si la V1 hebdomadaire suffit. La réponse fera passer cette ADR à
`Accepted` ou l'ajustera avant tout schéma.

## Validation attendue lors de l'implémentation

Les tests unitaires devront couvrir le calcul local, les bornes, les transitions
DST, l'idempotence et les opérations de cycle de vie. Des tests PostgreSQL
devront prouver l'absence de chevauchement sous concurrence, l'atomicité d'une
série en conflit et l'isolation tenant. La CI devra également couvrir les
parcours Browser Clerk TEST.
