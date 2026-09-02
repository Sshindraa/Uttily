# ADR-038 — Blocages manuels récurrents

**Statut :** Accepted

**Date :** 2026-09-02

**Relie à :** [ADR-035](ADR-035-closed-outdoor-equipment-taxonomy.md), aux lots
21-U2-V, 21-U2-W et à [l'architecture de disponibilité](../architecture/booking-and-availability.md).

## Contexte

Uttily sait créer, libérer et afficher un blocage manuel ponctuel
(`MANUAL_BLOCK`) sur un exemplaire. Les fermetures répétitives doivent conserver
la même autorité transactionnelle et ne doivent ni réinterpréter les horaires
locaux ni réécrire une période déjà commencée.

## Décision

Une série récurrente est un agrégat de planification distinct, rattaché à une
organisation, un établissement et un seul exemplaire physique. Elle conserve :

- `frequency = WEEKLY` uniquement en V1 ;
- une date de début et une date de fin obligatoires, sur une durée maximale de
  12 semaines (84 jours civils) ;
- une heure locale de début et de fin, sur le même jour civil en V1 ;
- le fuseau IANA explicite de l'établissement ;
- un statut `ACTIVE`, `SUSPENDED` ou `DELETED`.

Le serveur calcule chaque date hebdomadaire incluse dans la fenêtre et la
matérialise immédiatement en `MANUAL_BLOCK`. La table de liaison conserve une
occurrence par date et référence le bloc matérialisé. Le `source_id` du bloc
contient l'identifiant de cette occurrence pour conserver une trace vérifiable.
La contrainte PostgreSQL existante `no_overlapping_blocks` reste l'autorité
finale contre les réservations, holds, maintenances et blocages actifs.

Les heures sont des heures murales dans le fuseau fourni. Le serveur rejette
un horaire inexistant ou ambigu lors d'un changement d'heure (DST), sans
choisir silencieusement un décalage. Le fuseau fourni doit correspondre à
celui de l'établissement au moment de chaque opération. Les dates sont
stockées comme dates civiles de la règle ; les blocs matérialisés sont stockés
en UTC.

La création, la modification, la suspension, la reprise, la suppression
logique et la libération explicite d'une occurrence exigent l'autorisation
serveur existante pour les rôles `OWNER`, `ADMIN` et `MANAGER`. Chaque mutation
est tenant-safe, verrouille l'organisation et les ressources concernées dans
une transaction et utilise une clé d'idempotence. Une clé rejouée avec le
même payload restitue le résultat sans nouvelle écriture ; réutilisée avec un
payload différent, elle est refusée.

## Cycle de vie

- **Créer :** vérifier l'exemplaire actif, son établissement, le fuseau, les
  bornes, le calendrier local et tous les conflits avant de matérialiser la
  série. Une seule transaction crée la série et toutes ses occurrences ; un
  seul conflit annule l'ensemble.
- **Modifier :** la famille, l'exemplaire, l'établissement, le fuseau et la
  périodicité sont immuables. Les dates et horaires peuvent être ajustés, mais
  seules les occurrences futures non commencées sont modifiées ou ajoutées.
  Une occurrence active future qui sortirait de la nouvelle fenêtre doit être
  libérée explicitement avant la réduction. Les occurrences passées, déjà
  commencées ou déjà libérées restent inchangées et auditables.
- **Suspendre :** arrête le cycle et ne libère aucune occurrence existante.
- **Reprendre :** réactive explicitement le cycle et matérialise seulement les
  occurrences futures manquantes, après revalidation des conflits.
- **Supprimer :** passe la série à `DELETED` sans supprimer ni libérer ses
  occurrences. La libération d'une occurrence reste une action séparée,
  idempotente, qui applique `RELEASED` au `MANUAL_BLOCK`.

Il n'existe pas de série infinie, d'exception, de périodicité mensuelle, de
série multi-exemplaires, de règle de conflit automatique, ni de cron/worker.
La fenêtre est finie et matérialisée lors des mutations autorisées.

## Interfaces et disponibilité

La flotte expose une action générique de planification pour un exemplaire et le
planning identifie les occurrences récurrentes sans vocabulaire vélo. Les
réservations, la recherche publique, les paiements et les catégories ne sont
pas modifiés par cette décision. Ils continuent de voir un `MANUAL_BLOCK`
matérialisé comme une indisponibilité normale. Les permissions et l'isolation
tenant restent contrôlées côté serveur ; l'interface ne porte aucune règle de
concurrence.

## Hors périmètre V1

- récurrence quotidienne, mensuelle, RRULE ou règles complexes ;
- horaires de nuit traversant un jour civil ;
- exceptions, vacances, jours fériés ou occurrences multi-exemplaires ;
- génération infinie, cron, worker ou moteur de packs/suppléments ;
- modification des réservations, holds, maintenances, catégories, prix,
  recherche publique ou paiements.

## Validation

Les tests couvrent le calcul hebdomadaire, les bornes civiles, les fuseaux,
les heures DST inexistantes et ambiguës, l'idempotence et le cycle de vie. Les
tests PostgreSQL couvrent l'atomicité en cas de conflit, le verrouillage
concurrent, l'isolation tenant et l'absence de chevauchement.
