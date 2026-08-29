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

### Snapshots de prix flexible (G7P-B2-A, ADR-018, migration 0033)

Les tables `booking_drafts`, `booking_draft_lines`, `bookings` et
`booking_lines` sont étendues avec des colonnes de snapshot de prix flexible.
Deux versions de snapshot coexistent :

- `legacy-daily-v1` (défaut) : snapshots existants du modèle journalier
  ADR-009. Toutes les colonnes flexibles sont NULL.
- `flexible-pricing-v1` : nouveaux snapshots créés par le moteur G7P-B1.

**Colonnes sur `booking_drafts` et `bookings`** : `pricing_snapshot_version`
(text NOT NULL DEFAULT `'legacy-daily-v1'`), `pricing_algorithm_version`,
`pricing_rounding_rule_version`, `pricing_intent_type` (`'TIME_RANGE'` ou
`'DAY_RANGE'`), `pricing_intent_snapshot` (jsonb), `pricing_resolved_locale`.

**Colonnes sur `booking_draft_lines` et `booking_lines`** :
`pricing_plan_id` (FK vers `pricing_plans`, DEFERRABLE), `pricing_plan_version`,
`pricing_plan_type` (`'HOURLY'`|`'FIXED_DURATION'`|`'DAILY'`),
`pricing_public_label`, `pricing_requested_duration_minutes`,
`pricing_billed_duration_minutes` (HOURLY), `pricing_covered_duration_minutes`
(FIXED_DURATION), `pricing_billed_days` (DAILY), `pricing_selected_window`
(jsonb — `PricingWindowSnapshot`, union discriminée `TIME_RANGE_WINDOW` |
`DAY_RANGE_BOUNDARIES`), `pricing_discount_threshold_days` (DAILY), `pricing_discount_percent`
(DAILY), `pricing_amount_before_discount_minor` (DAILY),
`pricing_amount_after_discount_minor` (DAILY).

**Référence source explicite** : `booking_lines.source_draft_line_id` est une
FK DEFERRABLE INITIALLY DEFERRED vers `booking_draft_lines(id)`, avec un index
unique. Pour les lignes flexibles, elle est `NOT NULL` ; pour les lignes legacy
elle est `NULL`. Le trigger `enforce_booking_line_pricing_coherence` vérifie
que la ligne de réservation est une copie exacte de cette source et ne consulte
pas le catalogue mutable (`pricing_plans`, `pricing_plan_translations`,
`locations`).

**Contraintes CHECK (Round 2 fail-closed)** : montants >= 0 et <= `Number.MAX_SAFE_INTEGER` ;
`amount_before >= amount_after` ; `discount_percent` 0–100 ; union discriminée
stricte par `pricing_plan_type` ; `pricing_snapshot_version = 'flexible-pricing-v1'`
exige exactement `algorithm_version = 'flexible-pricing-v1'`,
`rounding_rule_version = 'half-up-v1'`, `intent_type` dans `('TIME_RANGE','DAY_RANGE')`,
`intent_snapshot` JSON objet non vide, et `resolved_locale` non vide ;
`legacy-daily-v1` exige `algorithm_version`, `rounding_rule_version`,
`intent_type`, `intent_snapshot` et `resolved_locale` à `NULL`, ainsi que
`billable_unit = 'DAY'`. La contrainte `billable_unit_valid` accepte désormais
`'MINUTE'` en plus de `'DAY'` (requis pour les plans HOURLY facturés par
incrément). La contrainte `flexible_billable_unit_by_intent` (sur
`booking_drafts` et `bookings`) impose : `TIME_RANGE → billable_unit IN
('MINUTE','DAY')`, `DAY_RANGE → billable_unit = 'DAY'`. Le trigger
`enforce_draft_line_pricing_coherence` applique des règles spécifiques par
intent sur `pricing_requested_duration_minutes` : `DAY_RANGE → NULL`,
`TIME_RANGE → > 0`.

**Triggers fail-closed** : immutabilité du snapshot financier (drafts : seuls `status`,
`expires_at`, `updated_at` modifiables ; lignes et bookings : insert-only ;
`created_at` ajouté aux colonnes immuables, DELETE interdit pour `booking_drafts` si
`status IN ('HELD','PAYMENT_PROCESSING')`, INSERT de ligne de brouillon autorisé
uniquement si le parent est `DRAFT`, `draft_id` et `variant_id` immuables) ;
cohérence complète `pricing_plan_id` : org, variante, devise, version, type,
état `ACTIVE` (uniquement en brouillon), vérifiée avec verrou `FOR SHARE`
(ordre : ligne -> parent -> plan). **Pour les `booking_lines`, aucune re-validation
 du catalogue mutable** : la source de vérité est `source_draft_line_id` ; le trigger
 ne consulte plus `pricing_plans`, `pricing_plan_translations` ni `locations`.
La copie exacte de `booking_drafts` vers `bookings` est contrôlée par
`validate_flexible_booking_aggregates` (tous les champs racine comparés avec
`IS DISTINCT FROM`). ; règle parent/line fail-closed (legacy = NULL
partout, flexible = snapshot complet) ; arithmétique canonique par type
(line_total = unit_price * billable_unit_count * quantity, line_total = amount_after
pour DAILY) ; remise half-up et palier applicable ; agrégats DEFERRABLE
INITIALLY DEFERRED, déclenchés sur `INSERT` ou `UPDATE OF status`
conditionnés à `flexible-pricing-v1` (subtotal = sum(line_total), au moins une ligne,
même devise) ; copie exacte de `booking_draft_lines` vers `booking_lines`
(pour flexible).

Les snapshots legacy restent lisibles ; aucune conversion n'est tentée.
`daily_price_amount_minor` et `calculatePrice` restent inchangés.
`createBookingDraftWithHold` supporte deux chemins : legacy (`legacy-daily-v1`,
inchangé) et flexible (`flexible-pricing-v1`, G7P-B2-B) via une union
discriminée en entrée.

### Confirmation et copie des champs flexibles (G7P-B2-C, ADR-018)

Lors de la confirmation (`applyBookingConfirmation`), tous les champs flexibles
sont copiés depuis `booking_drafts`/`booking_draft_lines` vers
`bookings`/`booking_lines`. Le brouillon est la seule source de vérité : aucun
re-lecture de `pricing_plans`, aucun recalcul et aucune reconversion UTC.

- **Champs racine copiés** : `timezone`, `billable_unit`, `billable_unit_count`,
  `pricing_snapshot_version`, `pricing_algorithm_version`,
  `pricing_rounding_rule_version`, `pricing_intent_type`,
  `pricing_intent_snapshot`, `pricing_resolved_locale`.
- **Champs ligne copiés** : `pricing_plan_id`, `pricing_plan_version`,
  `pricing_plan_type`, `pricing_public_label`,
  `pricing_requested_duration_minutes`, `pricing_billed_duration_minutes`,
  `pricing_covered_duration_minutes`, `pricing_billed_days`,
  `pricing_selected_window`, `pricing_discount_threshold_days`,
  `pricing_discount_percent`, `pricing_amount_before_discount_minor`,
  `pricing_amount_after_discount_minor`.

`source_draft_line_id` sur `booking_lines` est la FK explicite vers
`booking_draft_lines(id)` : non-null pour les lignes flexibles, NULL pour les
lignes legacy. Cette règle est imposée par le trigger
`enforce_booking_line_pricing_coherence`.

Les triggers de la migration 0033 imposent la copie exacte pour les réservations
flexibles : `validate_flexible_booking_aggregates` (root) et
`enforce_booking_line_pricing_coherence` (lines). Le document data loader
(`load-document-render-data.ts`) sélectionne ces champs flexibles pour les
réservations flexibles uniquement, préservant la forme du snapshot legacy pour
les réservations existantes.

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

### Modifications financières append-only (ADR-023, conception approuvée)

> ADR-023 (2026-08-10, Accepted — conception approuvée, implémentation non
> commencée). Voir
> `docs/decisions/ADR-023-booking-financial-amendments.md`.

Les modifications d'une réservation `CONFIRMED` sont tracées dans des tables
append-only dédiées. Les snapshots originaux (`bookings`, `booking_lines`,
`booking_items`) ne sont jamais mutés par un amendement.

```text
BookingAmendment
  - id (UUID PK)
  - organization_id (FK organizations)
  - booking_id (FK bookings)
  - amendment_number (INTEGER, monotone par booking)
  - type (NEUTRAL | SUPPLEMENT | REFUND)
  - status (HOLD_PENDING | READY_TO_APPLY | APPLIED | EXPIRED | CANCELLED | FAILED)
  - financial_snapshot_before (JSONB, immutable)
  - financial_snapshot_after (JSONB, immutable)
  - new_customer_start_at, new_customer_end_at
  - new_blocked_start_at, new_blocked_end_at
  - hold_deadline (timestamptz, nullable — SUPPLEMENT uniquement)
  - created_by (FK users)
  - created_at, updated_at, applied_at, expired_at

BookingAmendmentLine
  - id (UUID PK)
  - amendment_id (FK booking_amendments)
  - logical_line_id (UUID NOT NULL — identité stable entre amendements)
  - origin_type (ORIGINAL | AMENDMENT)
  - source_booking_line_id (FK booking_lines, nullable — ORIGINAL uniquement)
  - variant_id (FK product_variants)
  - action (ADD | MODIFY | REMOVE | UNCHANGED)
  - before_/after_ quantity, unit_price_amount_minor, line_total_amount_minor
  - pricing_snapshot, variant_snapshot (JSONB, immutable)
  - UNIQUE(amendment_id, logical_line_id), UNIQUE(amendment_id, variant_id)

BookingAmendmentAllocation
  - id (UUID PK)
  - amendment_id (FK booking_amendments)
  - amendment_line_id (FK booking_amendment_lines)
  - inventory_item_id (FK inventory_items)
  - action (RETAIN | ADD | REMOVE | REPLACE)
  - source_booking_block_id (FK inventory_blocks, nullable)
  - applied_booking_block_id (FK inventory_blocks, nullable)
  - status (PROPOSED | CONVERTED | RELEASED | EXPIRED)
  - effective_customer/blocked_start_at, end_at
  - UNIQUE(amendment_id, inventory_item_id)

BookingAmendmentSegment
  - id (UUID PK)
  - allocation_id (FK booking_amendment_allocations)
  - inventory_item_id (FK inventory_items)
  - hold_block_id (FK inventory_blocks, UNIQUE)
  - delta_start_at, delta_end_at
  - status (PROPOSED | CONVERTED | RELEASED | EXPIRED)

AmendmentPayment
  - id (UUID PK)
  - booking_id (FK bookings)
  - amendment_id (FK booking_amendments)
  - amount_minor, currency
  - status (PENDING_PROVIDER | REQUIRES_PAYMENT_METHOD | REQUIRES_ACTION | PROCESSING | SUCCEEDED | FAILED | CANCELLED)
  - provider_payment_intent_id, provider_idempotency_key

AmendmentPaymentAttempt
  - id (UUID PK)
  - amendment_payment_id (FK amendment_payments)
  - provider_payment_intent_id, provider_status, provider_idempotency_key
```

**Identité logique stable** : `logical_line_id` est conservé entre snapshots.
Pour une ligne originale, `logical_line_id = booking_line.id`. Pour une ligne
ajoutée, `logical_line_id = gen_random_uuid()` ; cet UUID est conservé par tous
les amendements suivants. Une ligne d'origine `AMENDMENT` peut être
`UNCHANGED`, `MODIFY` ou `REMOVE` sans `source_booking_line_id`.

**Projection canonique** : `getEffectiveBooking(bookingId)` est l'autorité de
l'état effectif — booking original si aucun amendement `APPLIED`, dernier
snapshot complet `APPLIED` sinon.

**Extension des refunds** : `refund_reason` étendu avec `BOOKING_MODIFICATION`
et `AMENDMENT_COMPENSATION` ; `refund_status` étendu avec
`FAILED_REQUIRES_MANUAL_ACTION` et `SETTLED_OFF_PLATFORM` ; colonnes
`settled_off_platform_at`, `settled_off_platform_by`, `settlement_notes` sur
`refunds`. `refunds.payment_id` devient nullable, `refunds.amendment_payment_id`
est ajouté (nullable, FK vers `amendment_payments.id`), contrainte CHECK XOR
(exactement une origine non-null). `BOOKING_MODIFICATION` référence le paiement
initial (`payment_id`) ; `AMENDMENT_COMPENSATION` référence le paiement de
supplément (`amendment_payment_id`). Triggers de cohérence organisation,
devise, environnement et montant entre le refund et son origine.

**Adaptation condition_reports/damage_reports** : `booking_item_id` devient
nullable, `amendment_allocation_id` est ajouté avec CHECK "exactement une
référence non-null".

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

- `audit_log` : journal append-only des actions administratives et opérationnelles.
  Protégé par trigger PostgreSQL (`prevent_update_delete_audit_log`) bloquant
  `UPDATE` et `DELETE` (ADR-016). FK `actor_user_id → users.id ON DELETE RESTRICT`
  (suppression dure d'utilisateur refusée si des entrées d'audit existent).
  `TRUNCATE` non bloqué (opération privilégiée hors contrat applicatif).

### Documents transactionnels (Lot 6 G5B, ADR-013)

Quatre tables livrées en G5B pour le flux documentaire déclenché par
`BOOKING_CONFIRMED.v1` :

- `document_render_snapshots` : snapshot de rendu figé au premier traitement du
  worker. Contient toutes les données de rendu (opaque en G5B, structuré en G5C)
  au format JSONB. `UNIQUE(outbox_event_id)` : un seul snapshot par événement.
  Append-only strict via trigger PostgreSQL (UPDATE et DELETE interdits). Trigger
  multi-tenant vérifiant que `organization_id` correspond à `outbox_events` et
  `bookings`.
- `documents` : métadonnées d'un document généré (confirmation, contrat, reçu).
  `UNIQUE(booking_id, type, version)` : une seule version par type par réservation.
  `UNIQUE(storage_key)` et `UNIQUE(idempotency_key)`. `size_bytes` en `bigint`
  (mode `number` Drizzle). `CHECK checksum_sha256 ~ '^[0-9a-f]{64}$'`. Append-only
  strict via trigger. Trigger multi-tenant vérifiant la cohérence entre
  `booking_id`, `source_outbox_event_id` et `render_snapshot_id` (même
  organisation, même outbox_event, même booking).
- `outbox_effects` : ledger des effets par événement (génération confirmation,
  contrat, reçu, envoi email). `UNIQUE(outbox_event_id, effect_type)`. Mutable
  avec transitions contrôlées : `PENDING → PENDING` (réservation storage_key, incrément attempt_count ; failure_code reste NULL), `PENDING → COMPLETED`, `PENDING → FAILED`. États
  terminaux (`COMPLETED`, `FAILED`) immuables. Colonnes immuables :
  `id`, `organization_id`, `outbox_event_id`, `effect_type`, `idempotency_key`,
  `created_at`. `attempt_count` ne peut jamais diminuer. `storage_key` immuable
  une fois renseignée. `document_id` ne peut être renseigné qu'au passage à
  `COMPLETED`. CHECK par `effect_type` : `SEND_EMAIL` exige `document_id` et
  `storage_key` NULL ; `GENERATE_*` + `COMPLETED` exige `document_id` et
  `storage_key` non-null. Partial unique index sur `storage_key` WHERE non-null.
  Trigger multi-tenant et trigger de transition (`before_check_outbox_effect_transition`).
- `notification_deliveries` : suivi de l'envoi d'un email transactionnel lié à un
  effet `SEND_EMAIL`. `UNIQUE(outbox_effect_id)` : une seule delivery par effet.
  `UNIQUE(provider_idempotency_key)` et `UNIQUE(idempotency_key)` : clés d'idempotence
  stables, sans PII, dérivées de `outboxEventId` uniquement
  (`email_provider_{outboxEventId}_SEND_EMAIL_v1` et `email_delivery_{outboxEventId}_v1`).
  `recipient_email` est figé au moment de la création (première Phase A) — lu depuis
  `users.email` via `bookings.customer_user_id` une seule fois, puis immuable.
  Les retries ne relisent **jamais** `users.email` : le `recipient_email` stocké
  dans `notification_deliveries` est réutilisé. Mutable avec transitions contrôlées :
  `PENDING → PENDING`, `PENDING → SENT`, `PENDING → FAILED`,
  `PENDING → REQUIRES_MANUAL_REVIEW`, `REQUIRES_MANUAL_REVIEW → SENT` (manuel),
  `REQUIRES_MANUAL_REVIEW → FAILED` (manuel). États terminaux
  (`SENT`, `FAILED`) immuables. `REQUIRES_MANUAL_REVIEW` immuable par le worker
  (résoluble uniquement par intervention humaine). CHECK : `PENDING` exige
  `provider_message_id`, `sent_at` et `failure_code` NULL ; `SENT` exige
  `provider_message_id` non vide, `sent_at` non null, `failure_code` NULL ;
  `FAILED` exige `failure_code` non null, `sent_at` NULL ; `REQUIRES_MANUAL_REVIEW`
  exige `provider_message_id` NULL, `sent_at` NULL, `failure_code` non-null dans
  l'ensemble fermé `('PROVIDER_RESULT_UNCERTAIN', 'EMAIL_RETRY_WINDOW_EXPIRED')`.
  Trigger multi-tenant vérifiant
  que l'effet est de type `SEND_EMAIL` et que `outbox_event_id` correspond. Trigger
  de transition (`before_check_notification_delivery_transition`). Trigger
  d'immutabilité du `provider_first_attempt_started_at` (BEFORE UPDATE). Voir
  §「G5H-C1 — Politique d'idempotence Resend < 24 h」ci-dessous pour le détail des
  transitions et contraintes ajoutées par G5H-C1.

Cinq enums PostgreSQL : `document_type`, `outbox_effect_type`,
`outbox_effect_status`, `notification_delivery_status`,
`document_processing_failure_code`. `notification_delivery_status` inclut
`REQUIRES_MANUAL_REVIEW` (ajouté par G5H-C1, migration 0029 planifiée).
`document_processing_failure_code` inclut `PROVIDER_RESULT_UNCERTAIN` et
`EMAIL_RETRY_WINDOW_EXPIRED` (ajoutés par G5H-C1). Les types TypeScript sont dérivés via `enumValues` Drizzle dans
`@uttily/core/transactional-documents`. Les ports d'infrastructure
(`DocumentRenderer`, `ObjectStorage`, `TransactionalEmailSender`) sont définis
comme interfaces fermées sans implémentation (G5C–G5E). Le contrat
`TransactionalEmailSender.send` retournera `Promise<EmailSendResult>`
(discriminated union `SENT` | `DETERMINISTIC_REFUSAL` | `TRANSIENT_NOT_SENT` |
`UNCERTAIN`) à partir de G5H-C2 (conception verrouillée G5H-C1, ADR-013 §13).
Le type `EmailSendResult` est une discriminated union fermée définie dans
ADR-013 §13.4. Structure : `SENT { providerMessageId }` |
`DETERMINISTIC_REFUSAL { failureCode }` | `TRANSIENT_NOT_SENT { failureCode }` |
`UNCERTAIN { failureCode }`. Les adapters conformes retournent `EmailSendResult`
et normalisent leurs erreurs attendues. MAIS le pipeline Core conserve un
try/catch défensif autour de `await sender.send()` pour toute exception
inattendue (sender défectueux, exception non-Error, bug adapter), normalisée en
`UNCERTAIN / UNKNOWN_FAILURE_AFTER_CALL_START`. Aucun raw Error, message, cause,
stack, PII ou secret ne traverse le pipeline. Ce contrat remplace l'actuel
`EmailResult` (interface simple `status: 'SENT'`) lors de l'implémentation G5H-C2.

### Snapshot de rendu v1 (Lot 6 G5C, ADR-013)

Le snapshot de rendu v1 est un type fermé et sérialisable figé au premier
traitement du worker documentaire. Il contient toutes les données nécessaires
au rendu des trois documents (confirmation, contrat, reçu) à partir des
autorités PostgreSQL, sans jamais truster le payload outbox.

**Contenu fermé du snapshot v1** :

- `snapshotVersion` : `'v1'` (constant).
- `sourceOutboxEventId`, `organizationId`, `bookingId`, `paymentId`, `draftId` :
  identifiants de déclenchement recoupés avec les autorités DB.
- `capturedAt` : horodatage ISO 8601 UTC canonique
  (`YYYY-MM-DDTHH:mm:ss.sssZ`) du moment de capture
  (`transaction_timestamp()` dans la transaction de création, normalisé via
  `toCanonicalIsoTimestamp`).
- `organization` : `id`, `legalName`.
- `location` : `id`, `name`, `addressLine1`, `addressLine2`, `city`,
  `postalCode`, `countryCode`, `timeZone` (IANA validé).
- `customer` : `userId`, `displayName`, `locale`. **Pas d'email** dans le
  snapshot (donnée de livraison actuelle, catégorie 3 ADR-013).
- `booking` : `id`, `status`, `customerStartAt`, `customerEndAt`,
  `confirmedAt`, `prepBufferMinutes`, `cleanupBufferMinutes`, `currency`,
  `subtotalAmountMinor`, `mandatoryFeesAmountMinor`, `totalAmountMinor`,
  `taxStatus`, `taxAmountMinor`, `taxRateBps`,
  `cancellationPolicySnapshot`, `termsAcceptanceSnapshot`.
  Pour un booking split, les champs publics `marketplaceFeeBaseAmountMinor`,
  `customerServiceFeeAmountMinor`, `customerTotalAmountMinor` et
  `marketplaceFeeRuleVersion` sont également exposés dans le snapshot client ;
  le détail loueur et l'application fee technique restent hors de ce snapshot.
  **Champs internes exclus** : `commissionAmountMinor`,
  `commissionRuleSnapshot`, `taxRuleSnapshot` (données internes de calcul,
  non pertinentes pour le rendu client).
- `payment` : `id`, `status`, `succeededAt`, `amountMinor`, `currency`,
  `financialTermsVersion`, `legalTermsVersion`.
  **Champs internes exclus** : `connectedAccountId`, `environment`,
  `onBehalfOfAccountId`, `client_secret` (identifiants Stripe Connect
  internes et secrets).
- `lines` : tableau trié par `lineId` (une entrée par `booking_line`).
- `items` : tableau trié par `bookingItemId` (une entrée par `booking_item`
  avec join `inventory_items`).

**Validation runtime** : le parser central `parseDocumentRenderSnapshotV1`
valide récursivement et strictement la forme, les types, les enums, les UUIDs,
les dates ISO canoniques, les montants (safe integers, signes), les
cohérences inter-objets, les relations item→line, le tri des tableaux et
l'absence de doublons. Codes d'erreur : `SNAPSHOT_INVARIANT` (forme) et
`VALIDATION` (type).

**Statuts acceptés** : les 7 statuts de `bookingStatus.enumValues`
(`CONFIRMED`, `READY_FOR_PICKUP`, `ACTIVE`, `RETURNED`, `CLOSED`,
`CANCELLED`, `REFUNDED`) sont acceptés. Un événement `BOOKING_CONFIRMED`
peut être traité tardivement après une annulation ou un remboursement.

**Type `LoadedDocumentRenderDataV1`** : `loadDocumentRenderData` retourne
`LoadedDocumentRenderDataV1` (sans `sourceOutboxEventId` ni `capturedAt`).
Ces deux champs sont ajoutés par `get-or-create-document-render-snapshot`
après validation de l'événement et capture du timestamp transactionnel.

**Immuabilité** : la table `document_render_snapshots` est append-only (trigger
PostgreSQL). `UNIQUE(outbox_event_id)` garantit un seul snapshot par événement.
Les retries utilisent toujours le snapshot existant, jamais les données live.

**Déterminisme** : la sérialisation canonique JSON (clés triées
récursivement, ordre des tableaux préservé, rejet de `undefined`/`bigint`/
`NaN`/`Infinity`/`Date`/fonction/symbol/référence circulaire) garantit que
mêmes inputs produisent mêmes bytes et mêmes checksums.

**Absence d'email, de secrets et de champs internes** : le snapshot ne
contient jamais `recipientEmail`, `client_secret`, numéro de carte, payload
Stripe brut, texte légal inventé, SIRET/RCS ou adresse légale absente,
`commissionAmountMinor`, `commissionRuleSnapshot`, `taxRuleSnapshot`,
`connectedAccountId`, `environment`, `onBehalfOfAccountId`.

### Fulfillment opérationnel (Lot 6, ADR-012)

Trois tables append-only persistant la preuve opérationnelle des transitions
terrain, les rapports d'état et les déclarations de dommage :

- `booking_fulfillment_events` : historique des 4 transitions nominales
  (`PREPARED`, `PICKED_UP`, `RETURNED`, `CLOSED`). Chaque événement enregistre
  `previous_status`, `next_status`, `actor_user_id` et une `idempotency_key`
  unique par organisation. La cohérence `event_type ↔ status` est garantie par
  CHECK. Append-only via trigger PostgreSQL.
- `condition_reports` : état physique d'un exemplaire à une phase (`PICKUP` ou
  `RETURN`). Rattaché au `booking`, au `booking_item` et à l'`inventory_item`.
  Trigger vérifiant la chaîne complète et la cohérence multi-tenant.
- `damage_reports` : déclaration de dommage sur un exemplaire pendant un cycle.
  Mêmes règles de rattachement, multi-tenant et append-only que
  `condition_reports`. La gravité, responsabilité et résolution sont reportées.

Aucune de ces tables ne modifie automatiquement `inventory_items.condition` ni
ne crée de bloc `MAINTENANCE`. Les photos et signatures sont reportées.

### G5H-C1 — Politique d'idempotence Resend < 24 h et fail-closed (conception finale, ADR-013 §13)

La conception finale de la politique d'idempotence Resend < 24 h et fail-closed
est verrouillée dans ADR-013 §13 (G5H-C1). L'implémentation (migration 0029
unique transactionnelle, contrat Core, adapter, pipeline, finalizer DB-only,
tests) est livrée (G5H-C2A, C2B, C2C-A, C2C-B1, C2C-B2, C2C-B3, C2C-B4 livrés). Cette section documente les changements de schéma
prévus.

#### Nouvel état `REQUIRES_MANUAL_REVIEW`

L'énumération `notification_delivery_status` est étendue :

```text
PENDING | SENT | FAILED | REQUIRES_MANUAL_REVIEW
```

- `REQUIRES_MANUAL_REVIEW` : la livraison a un résultat incertain (l'email a pu
  être envoyé) avec `MAX_ATTEMPTS` atteint ou âge ≥ 23 h, ou le cutoff de 23 h est
  dépassé. Un résultat `UNCERTAIN` avec âge < 23 h et `attempts < MAX_ATTEMPTS`
  est **retryé automatiquement** (retry idempotent avec même
  `providerIdempotencyKey` et même payload). Le worker automatique ne fait
  **jamais** de transition depuis ou vers `REQUIRES_MANUAL_REVIEW` (sauf `PENDING →
  REQUIRES_MANUAL_REVIEW`). Seul un humain peut résoudre cet état
  (`REQUIRES_MANUAL_REVIEW → SENT` ou `REQUIRES_MANUAL_REVIEW → FAILED`) via un use
  case administratif futur (transactions administratives atomiques).

#### Nouvelle colonne `provider_first_attempt_started_at`

- **Table** : `notification_deliveries`.
- **Colonne** : `provider_first_attempt_started_at` (`timestamptz`, nullable,
  default NULL).
- **Persistance** : dans la transaction courte fenced de Phase B, juste avant
  l'appel externe `sender.send()`. Valeur : `transaction_timestamp()`.
- **Immutabilité** : une fois renseignée (non-null), **jamais** modifiée. Un
  trigger `BEFORE UPDATE` lève une exception si
  `OLD.provider_first_attempt_started_at IS NOT NULL AND
  NEW.provider_first_attempt_started_at IS DISTINCT FROM
  OLD.provider_first_attempt_started_at`.
- **Rôle** : permet le calcul conservatif de l'âge du premier appel fournisseur.
  Si le timestamp est non-null, on suppose qu'un appel a pu avoir lieu (crash
  entre persistance et appel réseau inclus).

#### Nouveaux failure codes `PROVIDER_RESULT_UNCERTAIN` et `EMAIL_RETRY_WINDOW_EXPIRED`

L'énumération `document_processing_failure_code` est étendue avec
`PROVIDER_RESULT_UNCERTAIN` (résultat incertain après début d'appel fournisseur)
et `EMAIL_RETRY_WINDOW_EXPIRED` (NOUVEAU — pour `REQUIRES_MANUAL_REVIEW` causé par
cutoff ≥ 23 h).

#### Transitions mises à jour

| Transition | Acteur | Conditions |
| --- | --- | --- |
| `PENDING → PENDING` | worker | retry dans fenêtre < 23 h |
| `PENDING → SENT` | worker | succès, `providerMessageId` non vide |
| `PENDING → FAILED` | worker | refus terminal certain |
| `PENDING → REQUIRES_MANUAL_REVIEW` | worker | résultat incertain (MAX atteint ou âge ≥ 23 h) ou cutoff ≥ 23 h ; outbox remis en `PENDING` avec lease nettoyée |
| `REQUIRES_MANUAL_REVIEW → SENT` | humain uniquement | opérateur confirme envoi |
| `REQUIRES_MANUAL_REVIEW → FAILED` | humain uniquement | opérateur confirme non-envoi |
| `SENT` | immuable | — |
| `FAILED` | immuable | — |
| `REQUIRES_MANUAL_REVIEW` | immuable par le worker | seul un humain peut le résoudre |

#### CHECK constraints pour `REQUIRES_MANUAL_REVIEW`

```sql
CHECK (status <> 'REQUIRES_MANUAL_REVIEW'
       OR (provider_message_id IS NULL AND sent_at IS NULL
           AND failure_code IN ('PROVIDER_RESULT_UNCERTAIN', 'EMAIL_RETRY_WINDOW_EXPIRED')))
```

`REQUIRES_MANUAL_REVIEW` a **toujours** un `failure_code` non-null appartenant à
l'ensemble fermé `('PROVIDER_RESULT_UNCERTAIN', 'EMAIL_RETRY_WINDOW_EXPIRED')`. Le
cutoff ne peut être calculé que si `provider_first_attempt_started_at` est
non-null. Il n'existe pas de cas NULL pour `failure_code` de
`REQUIRES_MANUAL_REVIEW`.

#### Cutoff à 23 heures

`PROVIDER_IDEMPOTENCY_WINDOW_SECONDS = 23 × 3600 = 82 800`. Une delivery dont
l'âge calculé en DB (`transaction_timestamp() -
provider_first_attempt_started_at`) est ≥ 23 h est exclue du retry automatique et
passe en `REQUIRES_MANUAL_REVIEW` avec `failure_code =
'EMAIL_RETRY_WINDOW_EXPIRED'`. Un résultat `UNCERTAIN` avec âge < 23 h et
`attempts < MAX_ATTEMPTS` est retryé automatiquement (retry idempotent).

#### Index partiels prévus (migration 0029)

- Index partiel sur `notification_deliveries(status) WHERE status =
  'REQUIRES_MANUAL_REVIEW'` (pour lister les livraisons en attente de revue).
- Index partiel sur
  `notification_deliveries(provider_first_attempt_started_at) WHERE
  provider_first_attempt_started_at IS NOT NULL` (pour le sweep des incertains
  âgés).

#### Exclusion du claim automatique

Le claim `outbox_events` et le sweeper filtrent les événements dont la
`notification_deliveries` associée est `REQUIRES_MANUAL_REVIEW` (filtre `NOT
EXISTS` sur `notification_deliveries.status`). Aucun retry automatique n'est tenté
tant que la delivery est en `REQUIRES_MANUAL_REVIEW`. Une delivery `PENDING` dont
l'âge calculé en DB est ≥ 23 h est traitée par une branche DB sûre lors du claim ou
du sweep : passage atomique en `REQUIRES_MANUAL_REVIEW` avec `failure_code =
'EMAIL_RETRY_WINDOW_EXPIRED'`, sans appel fournisseur.

#### Budget de retry email séparé

Le budget de retry email est basé **exclusivement** sur
`outbox_effects.attempt_count` de l'effet `SEND_EMAIL`, pas sur
`outbox_events.attempt_count` (compteur de claims/observabilité incrémenté lors
des claims documentaires). Le claim `READY_FOR_TRANSACTIONAL_EMAIL` filtre sur
`SEND_EMAIL.attempt_count < MAX_ATTEMPTS` via JOIN avec `outbox_effects`. Le
filtre global `outbox_events.attempt_count < MAX_ATTEMPTS` reste pour les autres
éligibilités (compensation Stripe, pipeline documentaire). Voir ADR-013 §13.12.

#### Finalizer DB-only

Un finalizer DB-only indépendant du claim normal traite deux scénarios sans appel
fournisseur (voir ADR-013 §13.13) :

- **Crash après dernière tentative** : lease expirée + `SEND_EMAIL.attempt_count
  >= MAX_ATTEMPTS` + `provider_first_attempt_started_at` non-null →
  `REQUIRES_MANUAL_REVIEW` / `PROVIDER_RESULT_UNCERTAIN`.
- **Cutoff sans nouvel appel** : âge >= 23 h (`transaction_timestamp() -
  provider_first_attempt_started_at >= interval '23 hours'`) →
  `REQUIRES_MANUAL_REVIEW` / `EMAIL_RETRY_WINDOW_EXPIRED`.

Priorité stable : `EMAIL_RETRY_WINDOW_EXPIRED` si âge >= 23 h, sinon
`PROVIDER_RESULT_UNCERTAIN`. Verrous `FOR UPDATE SKIP LOCKED` dans l'ordre
`outbox_events` → `outbox_effects` → `notification_deliveries`. Invariant
absolu : aucune 6e requête fournisseur n'est jamais effectuée.

#### Migration 0029 unique transactionnelle

La migration 0029 est une **seule migration transactionnelle** utilisant le
remplacement contrôlé des enums (rename + recreate + cast texte + drop old) dans
une transaction unique Drizzle. Le runner Drizzle (drizzle-orm 0.36.4) exécute
toutes les migrations en attente dans une transaction commune — le découpage en
deux fichiers est interdit. Journal attendu : 28 → 29 migrations (PAS 30). Cible
PostgreSQL 16. Voir ADR-013 §13.8.

### Fondations de recherche publique (Lot 7 G7C-R3, ADR-017, migration 0031)

La migration 0031 pose les fondations PostgreSQL de la recherche publique :
identifiants publics stables et immuables, pays commercialement activables,
destinations internationales avec bounding box et traductions par locale, garde
de publication minimale renforcée. L'indexation géospatiale et les read models
relèvent de G7D (non démarré). La migration 0031 reste le socle G7C, révisée en
place en G7C-R3. Pas de migration 0032.

#### `countries`

Table des pays commercialement activables. Clé primaire `country_code` (text,
format `^[A-Z]{2}$`). `is_active` boolean DEFAULT false : aucun pays n'est actif
par défaut. `default_currency` text NOT NULL (sans DEFAULT, CHECK ISO 3 :
`^[A-Z]{3}$`). `default_locale` text NOT NULL (sans DEFAULT, CHECK format
`^[a-z]{2}(-[A-Z]{2})?$` acceptant les locales régionales normalisées comme
`fr-FR` et `en-GB`). Chaque création de pays doit fournir explicitement ces deux
valeurs. La France sera configurée avec `EUR` et `fr`. Timestamps `created_at` /
`updated_at`. La France sera le premier pays activé par configuration
opérationnelle (pas de seed dans la migration).

#### `destinations`

Table des destinations globales configurées (première ville produit : Lyon). Chaque
destination porte un `public_id` (UUID stable, immuable via trigger), un `slug`
unique au format kebab-case (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), un `country_code`
text NOT NULL (FK vers `countries`), un `place_type` text NOT NULL
(`COUNTRY`/`REGION`/`CITY`/`LOCALITY`/`POINT_OF_INTEREST`), un `center` de type
`geometry(Point, 4326)` NOT NULL, `bbox_south`/`bbox_west`/`bbox_north`/`bbox_east`
double precision NOT NULL (bounding box en degrés décimaux), un `is_active`
(défaut `false`), un `sort_order` (entier non négatif, défaut 0), un `deleted_at`
(suppression logique) et les timestamps `created_at` / `updated_at`. La colonne
`label` a été supprimée : les libellés sont dans `destination_translations`.

Contraintes CHECK :

- `destinations_slug_format` : slug kebab-case.
- `destinations_place_type_valid` : `place_type` dans l'ensemble fermé.
- `destinations_sort_order_nonneg` : `sort_order >= 0`.
- `destinations_center_not_empty` : `NOT ST_IsEmpty(center)`.
- `destinations_center_longitude_range` : longitude ∈ [-180, 180].
- `destinations_center_latitude_range` : latitude ∈ [-90, 90].
- `destinations_bbox_lat_range` : `bbox_south` et `bbox_north` ∈ [-90, 90].
- `destinations_bbox_lon_range` : `bbox_west` et `bbox_east` ∈ [-180, 180].
- `destinations_bbox_south_lt_north` : `bbox_south < bbox_north` (strictement).
  Pas de contrainte `bbox_west <= bbox_east` pour permettre la représentation
  antiméridien (ex. Pacifique : west=170, east=-170).
- `destinations_active_not_deleted` : `NOT is_active OR deleted_at IS NULL`.

Trigger `prevent_destinations_public_id_mutation` : toute mutation de
`public_id` lève une exception. `public_id` est immuable.

Trigger `check_destination_activation` (BEFORE INSERT OR UPDATE OF `is_active`,
`country_code`) : l'activation (`is_active = true`) requiert que le pays
associé soit actif (`countries.is_active = true`) ET qu'une traduction FR ET une
traduction EN existent dans `destination_translations`. La désactivation
(`is_active = false`) est toujours autorisée (fail-closed). La désactivation
d'un pays (`countries.is_active = false`) n'annule pas automatiquement
l'activation de ses destinations existantes (le trigger ne se déclenche pas sur
`countries`) ; les futures lectures publiques (G7D+) doivent donc filtrer
explicitement `countries.is_active = true` ET `destinations.is_active = true`
pour garantir l'invisibilité des destinations d'un pays désactivé.

#### `destination_translations`

Table des libellés par locale. `id` UUID PK, `destination_id` UUID NOT NULL FK
vers `destinations` ON DELETE CASCADE, `locale` text NOT NULL (CHECK
`^[a-z]{2}(-[A-Z]{2})?$` acceptant les locales régionales), `label` text NOT NULL
(CHECK non vide après trim). UNIQUE
`(destination_id, locale)`. Timestamps `created_at` / `updated_at`.

Trigger `protect_destination_required_translations` (BEFORE DELETE OR UPDATE) :
empêche la suppression, le changement de locale ou le déplacement
(destination_id) d'une traduction FR ou EN d'une destination active. La
suppression est autorisée si la destination est inactive.

#### `organizations.public_display_name`

Colonne `text` nullable. CHECK `organizations_public_display_name_not_empty` :
si non NULL, la valeur doit être non vide après trim. Requise avant toute
publication d'offre publique. `legal_name` n'est **jamais** un fallback : un
nom d'affichage public explicite est obligatoire pour exposer une organisation
dans la recherche publique. Une organisation sans `public_display_name` est
exclue des futures lectures publiques (G7D+).

#### `products.public_id`

Colonne `uuid` NOT NULL UNIQUE, auto-générée (`gen_random_uuid()`), backfillée
pour les lignes existantes. Immuable via trigger
`prevent_products_public_id_mutation`. Utilisé comme identifiant public stable
dans les routes et read models de recherche.

#### `locations.public_id`

Colonne `uuid` NOT NULL UNIQUE, auto-générée (`gen_random_uuid()`), backfillée
pour les lignes existantes. Immuable via trigger
`prevent_locations_public_id_mutation`.

#### `locations.operating_currency`

Colonne `text` NOT NULL, CHECK `^[A-Z]{3}$` (ISO 4217). Ajoutée par la
migration 0032 (G7P-A), backfillée depuis `organizations.default_currency`.
Représente la devise opérationnelle du magasin : autorité finale pour les
plans tarifaires locaux (un plan local doit utiliser la même devise que son
magasin, via trigger `check_pricing_plan_tenant_consistency`). L'organisation
reste le défaut d'onboarding (`organizations.default_currency`), mais la
colonne par magasin permet à un même tenant d'opérer des magasins dans des
devises différentes (ex. EUR et CHF) sans conversion implicite.

#### `locations.is_publicly_listed`

Colonne `boolean` NOT NULL, défaut `false`. CHECK
`locations_public_listing_requirements` (renforcée en G7C-R3) :
`NOT is_publicly_listed OR (pickup_enabled AND geo_point IS NOT NULL AND
deleted_at IS NULL AND length(btrim(address_line1)) > 0 AND
length(btrim(city)) > 0 AND country_code IS NOT NULL AND country_code ~
'^[A-Z]{2}$')`.

Fail-closed : un établissement non explicitement listé (`is_publicly_listed =
false`) est exclu de la recherche publique. La mise à `true` exige
simultanément `pickup_enabled = true`, un `geo_point` non NULL, l'absence de
suppression logique, une `address_line1` non vide, une `city` non vide et un
`country_code` non NULL au format ISO alpha-2. Le `postal_code` n'est pas
universellement obligatoire.

Note : `is_publicly_listed` est une condition nécessaire mais non suffisante pour
l'inclusion dans une recherche publique. L'éligibilité complète (organisation
active, produit `PUBLISHED`, variante à prix positif, etc.) est vérifiée au niveau
de la requête de recherche (G7D+), car une contrainte CHECK ne peut pas référencer
une table parent. Le drapeau garantit fail-closed au niveau local ; la requête
garantit l'éligibilité globale.

#### Index

- `countries_is_active_index` : partial index sur `countries(is_active)` WHERE
  `is_active = true`.
- `destinations_active_by_country_type_order_index` : partial index sur
  `destinations(country_code, place_type, sort_order)` WHERE `is_active = true
  AND deleted_at IS NULL`.
- `destination_translations_destination_locale_index` : index sur
  `destination_translations(destination_id, locale)`.
- `locations_publicly_listed_index` : partial index sur
  `locations(is_publicly_listed)` WHERE `is_publicly_listed = true`.
- Pas d'index spatial (l'indexation de recherche publique relève de G7D).

> **Note (2026-08-07, révisée 2026-08-07)** : La migration 0031 a été révisée en
> place en G7C-R3 (ce cycle) plutôt que par une migration additive 0032, car
> aucune dette schématique n'avait encore été introduite (0031 n'était pas
> commitée). La révision a ajouté : table `countries`, colonnes `country_code` /
> `place_type` / `bbox_*` sur `destinations`, suppression de `label` sur
> `destinations`, table `destination_translations`, triggers
> `check_destination_activation` et `protect_destination_required_translations`,
> et renforcement de `locations_public_listing_requirements`.

## Tarification flexible (ADR-018, G7P-A Round 2 terminé — schéma uniquement)

> ADR-018 (2026-08-07, Accepted — G7P-A Round 2 terminé le 2026-08-07, schéma
> uniquement ; G7P-B2-A terminé, G7P-B2-B Round 2 terminé et validé, G7P-B2-C
> implanté le 2026-08-08). Voir
> `docs/decisions/ADR-018-flexible-rental-duration-pricing-and-modification.md`.

Le modèle daily-only historique (`daily_price_amount_minor` sur
`product_variants`) est complété (et sera à terme remplacé) par un modèle de
plans tarifaires par variante. La migration 0032 (G7P-A Round 2) crée le schéma
PostgreSQL ; le moteur de sélection et de calcul est reporté à G7P-B.

### `locations.operating_currency`

Colonne `text` NOT NULL, CHECK `^[A-Z]{3}$` (ISO 4217), backfillée depuis
`organizations.default_currency`. Autorité finale pour la devise des plans
tarifaires locaux : un plan rattaché à un magasin doit utiliser la même devise
que `operating_currency` (trigger `check_pricing_plan_tenant_consistency`).
Permet à un tenant d'opérer des magasins dans des devises différentes (ex. EUR
et CHF) sans conversion implicite. Aucune conversion de devise n'est
implémentée en G7P-A Round 2.

Protection parent-side : le trigger `protect_location_operating_currency`
empêche le changement de `operating_currency` si des plans `ACTIVE` locaux ou
des fenêtres rattachées à des plans `ACTIVE` deviendraient incohérents (devise
du plan ≠ nouvelle devise du magasin).

### `pricing_plans`

Un plan tarifaire par ligne, avec un type enum `pricing_plan_type`
(`HOURLY` | `FIXED_DURATION` | `DAILY`), un prix en unités mineures
(`price_amount_minor` bigint, CHECK > 0 et <= 9007199254740991), une devise
(CHECK `^[A-Z]{3}$`), des paramètres de durée (`min_duration_minutes`,
`max_duration_minutes`, `included_duration_minutes`,
`billing_increment_minutes`), un `internal_label` optionnel (libellé interne
au loueur, non affiché publiquement), une priorité, un état de cycle de vie
`pricing_lifecycle_state` (`DRAFT` | `ACTIVE` | `RETIRED`) et une version
(CHECK > 0). Union discriminée stricte par `plan_type` (champs null/non-null
selon le type, contraintes `pricing_plans_hourly_fields`,
`pricing_plans_fixed_duration_fields`, `pricing_plans_daily_fields`). Cohérence
des bornes `HOURLY` uniquement (`max >= min`, `billing > 0`).

Clé métier (exclut la version) : `(product_variant_id, scope default/local,
currency, plan_type, included_duration_minutes pour FIXED_DURATION)`. La
version est un numéro de révision de la clé métier, pas une nouvelle offre
indépendante. Index unique partiel sur la clé métier pour les plans `ACTIVE`
(au plus un `ACTIVE` par clé métier) ; index unique historique sur
`(clé métier, version)`.

Cycle de vie fermé `DRAFT → ACTIVE → RETIRED`. Transitions autorisées :
`DRAFT→DRAFT`, `DRAFT→ACTIVE`, `ACTIVE→RETIRED` (toutes les autres interdites,
trigger `enforce_pricing_plan_lifecycle_transitions`). Immuabilité après
activation : si `lifecycle_state IN ('ACTIVE', 'RETIRED')`, seuls
`lifecycle_state` et `updated_at` peuvent changer (trigger
`enforce_pricing_plan_immutable_fields`). Suppression interdite si non-`DRAFT`
(trigger `prevent_pricing_plan_delete_if_not_draft`).

Héritage default/local : `location_id` nullable. NULL = plan par défaut
applicable à tous les magasins de même devise ; non NULL = plan local qui
remplace le plan par défaut portant la même clé fonctionnelle (variant, type,
durée incluse si applicable, devise) pour ce magasin, indépendamment du numéro
de version (un plan local v2 remplace un plan default v1). Unicité par index
partiels différenciés default/local et par type de plan (au plus un `HOURLY`
`ACTIVE` et un `DAILY` `ACTIVE` par variante/devise/contexte ; plusieurs
`FIXED_DURATION` `ACTIVE` autorisés avec unicité sur la clé métier incluant
`included_duration_minutes`).

Cohérence multi-tenant : trigger `check_pricing_plan_tenant_consistency`
(`plan.organization_id` = organisation de la variante ; si `location_id` non
NULL : `location.organization_id` = `plan.organization_id` ET
`plan.currency` = `location.operating_currency`).

### `pricing_plan_translations`

Table de traductions des libellés publics par locale. Colonnes :
`pricing_plan_id` (FK vers `pricing_plans` CASCADE), `locale` (text, CHECK
`^[a-z]{2}(-[A-Z]{2})?$`), `public_label` (text, CHECK non vide). Contrainte
`UNIQUE (pricing_plan_id, locale)`. FR (`fr`) et EN (`en`) requises pour
l'activation : le trigger `revalidate_pricing_plan_on_activation` rejette
toute transition vers `ACTIVE` si les traductions `fr` et `en` ne sont pas
présentes (entre autres vérifications). Les traductions sont gelées
(INSERT/UPDATE/DELETE interdits) quand le plan est `ACTIVE` ou `RETIRED`
(trigger `freeze_pricing_plan_translations`, qui verrouille le plan parent
avec `SELECT ... FOR UPDATE` pour sérialiser avec l'activation concurrente).

### `multi_day_discount_tiers`

Paliers de réduction multi-jours rattachés exclusivement à un plan `DAILY`
(trigger `check_multi_day_tier_plan_type`, qui verrouille le plan parent avec
`FOR UPDATE`). FK vers `pricing_plans` avec CASCADE. `threshold_days` >= 2,
`discount_percent` > 0 AND < 100 (strictement). Unicité
`(pricing_plan_id, threshold_days) WHERE active = true`. Monotonie des
réductions : quand le seuil augmente, la réduction ne doit pas diminuer
(trigger `enforce_tier_monotonic_discount`, qui verrouille le plan parent avec
`SELECT ... FOR UPDATE` au début pour sérialiser les insertions concurrentes).
Paliers gelés si le plan n'est pas `DRAFT` (trigger
`enforce_tier_draft_only_mutations`, qui verrouille le plan parent avec
`FOR UPDATE`). Pas de cumul (G7P-B choisira le meilleur palier applicable).
Les paliers d'un plan local sont indépendants de ceux du plan par défaut (pas
de fusion). La revalidation à l'activation vérifie aussi la monotonie de tous
les paliers actifs.

### `pricing_plan_windows`

Fenêtres commerciales fixes rattachées à un plan et à un magasin (FK vers
`pricing_plans` CASCADE, FK vers `locations`). `weekday_mask` integer CHECK
1–127 (bit 0 = lundi, bit 6 = dimanche ; 0 = aucun jour = invalide, 127 = tous
les jours). `start_time` / `end_time` time CHECK `end_time > start_time` (pas
de wraparound minuit — décision conservatrice G7P-A Round 2, voir ADR-018
§11). Fuseau fourni par la location (non stocké dans la fenêtre). Cohérence
devise : `window.location.operating_currency` = `plan.currency` pour les plans
par défaut et locaux (trigger `check_pricing_plan_window_tenant_consistency`).
Cohérence tenant : `location_id` même org que le plan, et si plan local →
`window.location_id` = `plan.location_id`. Fenêtres gelées si le plan n'est pas
`DRAFT` (trigger `enforce_window_draft_only_mutations`, qui verrouille le plan
parent avec `FOR UPDATE` pour sérialiser avec l'activation concurrente). La
revalidation à l'activation vérifie aussi toutes les fenêtres du plan.

### Résolution et backfill

Fonction `resolve_effective_pricing_plans(location_id)` : retourne les plans
locaux `ACTIVE` + les plans par défaut `ACTIVE` non remplacés par un plan
local, pour un magasin donné. L'`organization_id` et la `currency` sont dérivés
de la location côté base (fail-closed : location inexistante ou supprimée
logiquement → zéro ligne). Aucun paramètre tenant ou devise fourni par
l'appelant — la location est l'autorité pour la devise. Les plans par défaut
sont filtrés par `organization_id` de la location (isolation multi-tenant). La
résolution est indépendante du numéro de version (un plan local remplace le
défaut portant la même clé fonctionnelle quelle que soit la version).

Backfill : la migration 0032 crée un plan `DAILY` par défaut (`location_id`
NULL, `ACTIVE` v1, `currency` = variante) pour chaque variante ayant un
`daily_price_amount_minor` positif et non supprimée logiquement, avec les
traductions FR (`Tarif journalier`) et EN (`Daily rate`). Ne crée ni réduction
ni fenêtre inventée.

### Revalidation à l'activation et concurrence (Round 3)

Le trigger `revalidate_pricing_plan_on_activation` (BEFORE UPDATE OF
`lifecycle_state`, DRAFT → ACTIVE) revalide au moment de l'activation : la
cohérence organisation variante = organisation plan, la cohérence location
(org + currency + non supprimée) pour les plans locaux, les traductions FR+EN,
toutes les fenêtres (tenant, location, currency, mask/hours valides) et tous
les paliers (DAILY uniquement, threshold >= 2, discount 1-99, pas de doublons,
monotonie). L'ancien trigger `require_pricing_plan_translations_on_activation`
est fusionné dans cette fonction.

Les triggers enfants (`enforce_window_draft_only_mutations`,
`enforce_tier_draft_only_mutations`, `freeze_pricing_plan_translations`,
`check_multi_day_tier_plan_type`, `enforce_tier_monotonic_discount`)
verrouillent le plan parent avec `SELECT ... FOR UPDATE` avant de vérifier le
`lifecycle_state`. Cela sérialise les mutations enfants avec l'activation
concurrente : pas de plan `ACTIVE` avec une fenêtre/palier/traduction ajouté
après validation.

`protect_location_operating_currency` vérifie les plans DRAFT et ACTIVE (pas
seulement ACTIVE) lors d'un changement de `operating_currency`. Les plans
RETIRED (historiques, immuables) ne bloquent pas le changement de devise.

### Compatibilité Core

La colonne `daily_price_amount_minor` sur `product_variants` est conservée pour
compatibilité Core (double lecture transitional) ; le Core existant
(`calculate-price.ts`, `civil-days.ts`) continue de fonctionner sans
changement cassant. Les snapshots des réservations existantes ne sont pas
modifiés. G7P-A Round 2 = schéma uniquement, G7P-B2-A terminé, G7P-B2-B Round 2
terminé et validé, G7P-B2-C implanté.

## Conventions indispensables

- Identifiants UUID v4 générés par PostgreSQL via `gen_random_uuid()`.
- `organization_id` sur toute donnée appartenant à un loueur.
- Dates en UTC, fuseau local du lieu conservé avec l'établissement.
- Montants en entier (`amount_minor`) et `currency` obligatoire.
- Suppression logique pour les données métier, anonymisation séparée pour les obligations RGPD.
