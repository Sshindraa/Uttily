# Modèle de données initial

## Identité et organisations

```text
User
Organization
OrganizationMembership
Location
```

`OrganizationMembership` porte le rôle : `OWNER`, `ADMIN`, `MANAGER` ou `STAFF`. L'identité est fournie par Clerk (ADR-006) ; Uttily reste la source de vérité des rôles, droits et appartenances. Les invitations en attente d'acceptation sont stockées dans une table `OrganizationInvitation` distincte : aucun `User` n'est créé avant l'acceptation.

## Catalogue et stock

```text
Category (globale, arborescence profondeur ≤ 3)
Product
ProductVariant
InventoryItem
InventoryMovement
```

- `Category` : taxonomie globale gérée par l'admin Uttily. Arborescence via `parent_id` (profondeur maximale 3). Seed de 9 catégories racines au Lot 2A. Désactivation refusée tant que des produits `PUBLISHED` l'utilisent.
- `Product` : ce qui est vendu (ex. paddle 10'4). Un produit peut être `PUBLISHED` sans exemplaire en stock (l'indisponibilité temporaire est un état légitime). `publication_status` (`DRAFT | PUBLISHED | ARCHIVED`) est un état métier réversible, distinct de `deleted_at` (suppression logique technique).
- `ProductVariant` : taille, couleur ou configuration. Chaque produit a au moins une variante (variante « Standard » créée atomiquement à la création du produit). `product_id` est immuable. La désactivation ou suppression de la dernière variante active est rejetée par trigger PostgreSQL.
- `InventoryItem` : exemplaire physique, SKU interne, numéro de série, état et établissement courant. `status` (`ACTIVE | RETIRED | LOST`) = statut de gestion du parc, découplé de `condition` (`NEW | GOOD | FAIR | POOR | BROKEN`) = état physique. Un exemplaire `ACTIVE` et `BROKEN` est légitime (en attente de réparation). La disponibilité réelle (réservable ou non) est calculée au Lot 3 via `InventoryBlock`. La cohérence multi-tenant (location et variante appartiennent à la même organisation que l'exemplaire) est garantie par trigger PostgreSQL.
- `InventoryMovement` : journal append-only des transferts d'exemplaires entre établissements. Idempotent via `idempotency_key` unique par exemplaire. `from_location_id` = localisation courante verrouillée avant le transfert.

`MaintenanceRecord` est reporté au Lot 3 (blocages de maintenance via `InventoryBlock`) et Lot 6 (rapports d'état et dommages). Les photos de produits sont reportées au Lot 7 (fiche produit publique).

## Réservation

```text
BookingDraft
InventoryBlock
Booking
BookingLine
PriceSnapshot
Cancellation
```

`BookingLine` référence les exemplaires attribués. `PriceSnapshot` préserve les montants, taxes, devise, conditions et règles applicables au moment de la confirmation.

## Paiement et garantie

```text
Payment
PaymentAttempt
PaymentWebhook
Deposit
FinancialLedgerEntry
```

Une garantie conserve l'une des stratégies suivantes :

```text
CARD_AUTHORIZATION
EXTENDED_AUTHORIZATION
CARD_ON_FILE
INSURANCE
EXTERNAL_DEPOSIT
NO_DEPOSIT
```

`FinancialLedgerEntry` est append-only : les corrections sont de nouvelles écritures, jamais une modification destructive de l'historique.

## Opérations

```text
Pickup
Return
ConditionReport
DamageReport
Document
Notification
OutboxEvent
AuditLog
```

## Conventions indispensables

- Identifiants UUID v4 générés par PostgreSQL via `gen_random_uuid()`.
- `organization_id` sur toute donnée appartenant à un loueur.
- Dates en UTC, fuseau local du lieu conservé avec l'établissement.
- Montants en entier (`amount_minor`) et `currency` obligatoire.
- Suppression logique pour les données métier, anonymisation séparée pour les obligations RGPD.
