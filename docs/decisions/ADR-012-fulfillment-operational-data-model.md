# ADR-012 — Modèle de données opérationnel fulfillment

- **Statut** : accepté
- **Date** : 2026-08-04
- **Périmètre** : Lot 6 — Groupe G2, modèle de données opérationnel fulfillment
- **Dépendances** : ADR-003, ADR-010, ADR-011

## 1. Contexte

L'ADR-011 définit la machine à états pure des bookings. Les transitions nominales
sont `CONFIRMED → READY_FOR_PICKUP → ACTIVE → RETURNED → CLOSED`, auxquelles
s'ajoutent les transitions terminales `CONFIRMED → CANCELLED` et
`CONFIRMED → REFUNDED`. Le booking est créé à `CONFIRMED` par le webhook de
paiement `payment_intent.succeeded` dans la transaction atomique de conversion du
brouillon (ADR-010 §10).

Le groupe G1 a livré uniquement la fonction pure `projectBookingStatus` : aucune
persistance, aucun effet de bord. Le groupe G2 introduit le modèle de données
pour persister la preuve opérationnelle des transitions terrain, les rapports
d'état des exemplaires et les déclarations de dommage. Ce modèle ne modifie pas
la machine à états ni les use cases : il fournit les tables et contraintes
PostgreSQL sur lesquelles les futurs use cases s'appuieront.

## 2. Historique des transitions terrain — booking_fulfillment_events

La table `booking_fulfillment_events` est append-only et enregistre les quatre
transitions nominales de la machine à états :

| event_type  | previous_status  | next_status      |
| ----------- | ---------------- | ---------------- |
| `PREPARED`  | `CONFIRMED`      | `READY_FOR_PICKUP` |
| `PICKED_UP` | `READY_FOR_PICKUP` | `ACTIVE`       |
| `RETURNED`  | `ACTIVE`         | `RETURNED`       |
| `CLOSED`    | `RETURNED`       | `CLOSED`         |

Champs : `id`, `organization_id`, `booking_id`, `event_type`, `previous_status`,
`next_status`, `actor_user_id`, `idempotency_key`, `occurred_at`, `metadata`
(JSONB nullable), `created_at`.

Contraintes :

- unicité `(organization_id, idempotency_key)` ;
- `previous_status <> next_status` ;
- cohérence stricte `event_type ↔ previous_status ↔ next_status` via quatre
  contraintes CHECK ;
- l'organisation du booking doit correspondre à `organization_id` (trigger) ;
- append-only : triggers PostgreSQL interdisant `UPDATE` et `DELETE`.

Cette table ne remplace ni `audit_log` ni `outbox_events` :

- `booking_fulfillment_events` = preuve métier opérationnelle d'une transition
  terrain ;
- `audit_log` = traçabilité transverse des mutations ;
- `outbox_events` = effets secondaires asynchrones.

Les transitions `CANCELLED` et `REFUNDED` ne sont **pas** des événements terrain
G2 : elles relèvent de l'annulation et du remboursement, traités par d'autres
mécanismes.

## 3. Rapports d'état — condition_reports

La table `condition_reports` enregistre l'état physique d'un exemplaire à un
moment du cycle de location.

Champs : `id`, `organization_id`, `booking_id`, `booking_item_id`,
`inventory_item_id`, `phase` (`PICKUP | RETURN`), `condition` (enum
`inventory_condition` existant : `NEW | GOOD | FAIR | POOR | BROKEN`), `notes`
(nullable), `reporter_user_id`, `idempotency_key`, `created_at`.

Règles :

- rattachement explicite au booking et à l'exemplaire ;
- le `booking_item` doit appartenir au booking et référencer le même
  `inventory_item` (trigger vérifiant la chaîne complète) ;
- toutes les entités (booking, booking_item, inventory_item) doivent appartenir à
  la même organisation (trigger) ;
- unicité `(organization_id, idempotency_key)` ;
- append-only : triggers PostgreSQL interdisant `UPDATE` et `DELETE` ;
- plusieurs rapports par phase sont intentionnellement autorisés (pas de limite) ;
- aucune photo dans G2.

## 4. Déclarations de dommage — damage_reports

La table `damage_reports` enregistre une déclaration de dommage sur un exemplaire
pendant un cycle de location.

Champs : `id`, `organization_id`, `booking_id`, `booking_item_id`,
`inventory_item_id`, `description` (non vide), `reporter_user_id`,
`idempotency_key`, `created_at`.

Règles : identiques à `condition_reports` (rattachement, cohérence multi-tenant,
idempotence, append-only).

Ne sont **pas** inventés dans G2 : gravité, responsabilité, montant, statut de
résolution, photos, mise automatique à `BROKEN` de l'exemplaire, création
automatique d'un bloc `MAINTENANCE`. Ces décisions restent ouvertes et seront
traitées dans un groupe ultérieur.

## 5. Triggers append-only

Trois triggers distincts interdisent `UPDATE` et `DELETE` sur les trois tables
`booking_fulfillment_events`, `condition_reports` et `damage_reports`. Chaque
table dispose d'un trigger `BEFORE UPDATE` et d'un trigger `BEFORE DELETE` qui
lèvent une exception.

Cela renforce l'invariant qui manquait à `audit_log` (cf. ADR-011 §7) :
l'append-only y est garanti par convention applicative uniquement, sans trigger
PostgreSQL. G2 applique ce renforcement dès la création des tables fulfillment.

## 6. Périmètre reporté

- photos et signatures : reportées ;
- la condition rapportée ne modifie pas automatiquement
  `inventory_items.condition` ;
- un dommage ne crée pas automatiquement un bloc `MAINTENANCE` ;
- rôles et use cases : reportés à G3 ;
- génération de documents : reportée à un groupe ultérieur.

## 7. Questions ouvertes

Les questions produit relatives au fulfilment (rôles autorisés, annulation après
`READY_FOR_PICKUP`, statuts pouvant passer à `REFUNDED`, relation
`CANCELLED`/`REFUNDED`, traitement du no-show) sont déjà documentées par G1 dans
`docs/implementation/open-questions.md`. G2 n'ajoute pas de nouvelle question
ouverte : le modèle de données est neutre vis-à-vis de ces décisions.

## 8. Règles de statut booking pour les rapports (G3B)

### Rapport d'état (condition_reports)

| Phase | Statut booking requis |
| --- | --- |
| PICKUP | READY_FOR_PICKUP |
| RETURN | ACTIVE |

Le rapport doit normalement être créé AVANT la transition pickupBooking (PICKUP) ou
returnBooking (RETURN) correspondante. Le rejeu avec la même clé d'idempotence reste
possible après la transition grâce à idempotency_records, sans relire l'état métier.

### Déclaration de dommage (damage_reports)

| Statut booking | Autorisé |
| --- | --- |
| ACTIVE | oui |
| RETURNED | oui |
| CONFIRMED | non |
| READY_FOR_PICKUP | non |
| CLOSED | non |
| CANCELLED | non |
| REFUNDED | non |

### Périmètre explicitement exclu (maintenu)

- Aucune photo, gravité, responsabilité ou montant.
- Aucune modification automatique de inventory_items.condition.
- Aucun passage automatique à BROKEN.
- Aucun bloc MAINTENANCE automatique.
