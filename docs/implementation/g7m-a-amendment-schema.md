# G7M-A — Fondations PostgreSQL append-only des amendements financiers

- **Statut** : Livré (database 778/778, Core 2180/2180, lint, typecheck, format, diff-check tous verts)
- **ADR de référence** : [ADR-023](../decisions/ADR-023-booking-financial-amendments.md)
- **Migration** : `0036_g7m_a_amendment_schema.sql`
- **Date** : 2026-08-11

## Périmètre livré

G7M-A implémente les fondations PostgreSQL append-only des amendements
financiers décidées par ADR-023. Ce lot est strictement limité au schéma, à la
migration, aux triggers d'intégrité, aux tests PostgreSQL et à la documentation
de livraison. Aucun flux métier, Stripe, webhook, worker, API ou UI n'est inclus.

## Migration

`packages/database/drizzle/0036_g7m_a_amendment_schema.sql` (1871 lignes,
transaction unique) — prochaine migration disponible après `0035_g7h_analytics_foundations`.

### Remplacement transactionnel des enums

Les enums `refund_reason` et `refund_status` sont reconstruits
transactionnellement (pattern 0029) car le runner Drizzle 0.36.4 exécute toutes
les migrations en attente dans une transaction commune. Les contraintes CHECK et
l'index unique dépendants (`refunds_late_payment_reverse_transfer`,
`refunds_late_payment_refund_application_fee`, `refunds_late_payment_unique`)
sont supprimés avant le `ALTER COLUMN TYPE` puis recréés avec le nouveau type.

## Tables créées

| Table | Rôle |
| --- | --- |
| `booking_amendments` | En-tête d'amendement append-only (type, statut, snapshots financiers, dates effectives, hold_deadline) |
| `booking_amendment_lines` | Snapshot complet des lignes par amendement (logical_line_id stable, origin_type, action, before/after) |
| `booking_amendment_allocations` | Snapshot des allocations effectives (RETAIN/ADD/REMOVE/REPLACE, source/applied block, périodes) |
| `booking_amendment_segments` | Delta-segments HOLD par allocation (hold_block_id unique, période delta) |
| `amendment_payments` | Paiement de supplément (1 par amendement SUPPLEMENT, EUR, environnement explicite) |
| `amendment_payment_attempts` | Attempts de paiement (provider_idempotency_key unique, un seul non-terminal) |

## Tables modifiées

| Table | Changement |
| --- | --- |
| `refunds` | `payment_id` nullable, `amendment_payment_id` ajouté, contrainte XOR, colonnes `settled_off_platform_at`/`settled_off_platform_by`/`settlement_notes`, CHECK `reason`→origine |
| `condition_reports` | `booking_item_id` nullable, `amendment_allocation_id` ajouté, contrainte XOR, trigger de cohérence étendu |
| `damage_reports` | `booking_item_id` nullable, `amendment_allocation_id` ajouté, contrainte XOR, trigger de cohérence étendu |

## Enums créés

`amendment_type`, `amendment_status`, `amendment_line_origin_type`,
`amendment_line_action`, `amendment_allocation_action`,
`amendment_allocation_status`, `amendment_segment_status`,
`amendment_payment_status`, `amendment_payment_attempt_status`.

## Enums modifiés

- `refund_reason` : + `BOOKING_MODIFICATION`, + `AMENDMENT_COMPENSATION`
- `refund_status` : + `FAILED_REQUIRES_MANUAL_ACTION`, + `SETTLED_OFF_PLATFORM`

## Triggers et invariants

### booking_amendments

- `before_check_booking_amendment_consistency` : cohérence tenant
  (organisation du booking = organisation de l'amendement) ; validation INSERT
  (SUPPLEMENT → HOLD_PENDING, NEUTRAL/REFUND → READY_TO_APPLY, booking
  CONFIRMED, hold_deadline requis pour SUPPLEMENT et > created_at) ; validation
  des timestamps terminaux (non-NULL uniquement quand status est terminal).
- `before_check_booking_amendment_transition` : immutabilité des colonnes
  d'identité et des snapshots après création ; transitions conformes à ADR §5.1
  (HOLD_PENDING → HOLD_PENDING/READY_TO_APPLY/EXPIRED/CANCELLED ;
  READY_TO_APPLY → READY_TO_APPLY/APPLIED/FAILED) ; états terminaux
  (APPLIED/EXPIRED/CANCELLED/FAILED) immuables ; isolation des timestamps
  terminaux (seul le timestamp terminal correspondant au nouveau status peut
  être renseigné).
- `prevent_booking_amendment_deletion` : DELETE interdit (append-only).
- Index partiel `booking_amendments_single_active_per_booking` : un seul
  amendement actif (HOLD_PENDING ou READY_TO_APPLY) par booking.

### booking_amendment_lines

- `prevent_booking_amendment_line_modification` : append-only (UPDATE/DELETE interdits).
- `before_check_booking_amendment_line_consistency` : cohérence tenant
  (amendement et ligne de la même organisation) ; validation `source_booking_line_id`
  pour ORIGINAL (requis, appartient au même booking, même `logical_line_id`, même
  variante) ; validation `source_booking_line_id` NULL pour AMENDMENT ; règles
  d'action (ADD : before=0/after>0, MODIFY : before>0/after>0, REMOVE : before>0/after=0,
  UNCHANGED : before=after) ; validation `pricing_snapshot` est un objet JSON.

### booking_amendment_allocations

- `before_check_booking_amendment_allocation_transition` : immutabilité des
  colonnes d'identité ; transitions PROPOSED → PROPOSED/CONVERTED/RELEASED/EXPIRED ;
  états terminaux immuables ; rejet de la transition REMOVE → CONVERTED.
- `prevent_booking_amendment_allocation_deletion` : DELETE interdit.
- `before_check_booking_amendment_allocation_consistency` : cohérence tenant
  (amendement, ligne, item, organisation) ; statut initial PROPOSED ; source
  block requis pour RETAIN/REMOVE/REPLACE, interdit pour ADD ; source/applied
  block de type BOOKING, même org, même item, lié au booking ; périodes
  effectives incluses dans les périodes de l'amendement.

### booking_amendment_segments

- `before_check_booking_amendment_segment_transition` : immutabilité des
  colonnes d'identité ; transitions PROPOSED → PROPOSED/CONVERTED/RELEASED/EXPIRED ;
  états terminaux immuables.
- `prevent_booking_amendment_segment_deletion` : DELETE interdit.
- `before_check_booking_amendment_segment_consistency` : cohérence tenant +
  block référencé doit être `type=HOLD`, `status=ACTIVE`, non supprimé ;
  amendement de l'allocation doit être SUPPLEMENT ; statut initial PROPOSED ;
  période du segment doit exactement correspondre au HOLD block.

### amendment_payments

- `before_check_amendment_payment_consistency` : cohérence tenant
  (amendement, booking, organisation) + amendement doit être de type SUPPLEMENT ;
  `connected_account_id` et `customer_user_id` doivent correspondre à ceux du
  booking ; montant positif non-nul ; devise EUR ; environnement explicite ;
  statut initial PENDING_PROVIDER ; timestamps terminaux isolés.
- `before_check_amendment_payment_transition` : immutabilité des colonnes
  d'identité ; transitions conformes (PENDING_PROVIDER → PROCESSING/SUCCEEDED/FAILED,
  PROCESSING → SUCCEEDED/FAILED) ; états terminaux (SUCCEEDED/FAILED/CANCELLED)
  immuables ; timestamps terminaux isolés.

### amendment_payment_attempts

- `before_check_amendment_payment_attempt_consistency` : cohérence tenant ;
  `provider_idempotency_key` requis ; statut initial PENDING_PROVIDER ;
  `attempt_number` = max(attempt_number) + 1 pour le paiement.
- `before_check_amendment_payment_attempt_immutability` : immutabilité des
  colonnes d'identité + `provider_payment_intent_id` immuable une fois renseigné ;
  transitions conformes (PENDING_PROVIDER → PROCESSING/SUCCEEDED/FAILED,
  PROCESSING → SUCCEEDED/FAILED) ; états terminaux immuables.
- Index partiel `amendment_payment_attempts_single_non_terminal_attempt` :
  un seul attempt non-terminal par paiement.

### refunds (triggers mis à jour)

- `before_check_refund_org_consistency` (recréé) : gère les deux origines
  (payment_id XOR amendment_payment_id) avec cohérence d'organisation.
- `before_check_refund_amount_bound` : montant cumulé des refunds ne peut pas
  dépasser le montant du paiement initial ou de l'amendment payment.
- `before_check_refund_transition` : transitions conformes
  (PENDING → SUCCEEDED/FAILED, SUCCEEDED → immuable,
  FAILED → FAILED_REQUIRES_MANUAL_ACTION, FAILED_REQUIRES_MANUAL_ACTION → SETTLED_OFF_PLATFORM) ;
  états terminaux immuables ; colonnes `settled_off_platform_*` immuables
  sauf pour la transition vers SETTLED_OFF_PLATFORM.

### condition_reports / damage_reports (triggers recréés)

- `before_check_condition_report_consistency` / `before_check_damage_report_consistency` :
  étendus pour valider la cohérence tenant via `booking_item_id` XOR
  `amendment_allocation_id` ; vérification que l'`amendment_allocation_id`
  appartient à la même organisation.
- Triggers append-only recréés.

## Tests

`packages/database/src/schema-g7m-a-amendments.test.ts` (3830 lignes) — 103 tests PostgreSQL
réels (base dédiée `uttily_test_g7m_a`, migration from scratch).

Couverture :

- Création valide de chaque type d'amendement (NEUTRAL, SUPPLEMENT, REFUND)
- Rejet cross-tenant pour chaque relation critique (amendement, ligne,
  allocation, segment, paiement, attempt, refund avec amendment_payment_id)
- Unicité du numéro, un seul amendement actif
- Validation INSERT : SUPPLEMENT → HOLD_PENDING, NEUTRAL/REFUND → READY_TO_APPLY,
  booking doit être CONFIRMED, hold_deadline requis pour SUPPLEMENT
- Contraintes ORIGINAL/AMENDMENT, ADD/MODIFY/REMOVE/UNCHANGED valides et invalides
- Validation `source_booking_line_id` pour ORIGINAL (requis, même booking, même
  logical_line_id, même variante) et NULL pour AMENDMENT
- Validation `pricing_snapshot` est un objet JSON (rejet des tableaux)
- CHECKs renforcés : ADD avec before_unit_price=0, REMOVE avec after_unit_price=0
- Ligne ajoutée puis représentable dans un snapshot suivant
- Allocations RETAIN/ADD/REMOVE/REPLACE, statut initial PROPOSED
- Source block requis pour RETAIN/REMOVE/REPLACE, interdit pour ADD
- Plusieurs delta-segments, rejet d'un segment pointant vers un block non-HOLD
- Rejet d'un segment sur un amendement non-SUPPLEMENT
- Rejet d'un segment avec période != période du HOLD block
- Rejet d'un segment avec statut initial != PROPOSED
- Périodes invalides (amendements, allocations, segments)
- Immutabilité des snapshots, transitions autorisées et interdites, terminalité
- DELETE interdit sur amendements, allocations et segments (append-only)
- Timestamps terminaux : rejet si renseigné dans un état non-terminal
- Transitions d'allocation PROPOSED → CONVERTED/RELEASED, immutabilité terminal
- Rejet de la transition REMOVE → CONVERTED
- Transitions de segment PROPOSED → CONVERTED, immutabilité terminal
- Paiement supplément et attempts, montant/devise/environnement invalides
- `customer_user_id` du paiement doit correspondre au booking
- Statut initial PENDING_PROVIDER pour paiement et attempt
- `attempt_number` = max+1, `provider_idempotency_key` requis
- Attempt concurrent/non terminal unique
- Second attempt après un premier terminal
- Refunds avec payment initial, compensation avec amendment payment
- Montant cumulé des refunds ≤ montant du paiement initial/supplément
- Rejet cross-tenant d'un refund avec amendment_payment_id d'une autre org
- Rejet zéro ou deux origines de refund, conservation d'un refund historique
- Transitions de refund : PENDING → SUCCEEDED/FAILED, FAILED → FAILED_REQUIRES_MANUAL_ACTION,
  FAILED_REQUIRES_MANUAL_ACTION → SETTLED_OFF_PLATFORM, immutabilité des terminaux
- Colonnes `settled_off_platform_*` rejetées hors SETTLED_OFF_PLATFORM
- Condition/damage reports originaux et sur allocation d'amendement
- Rejet cross-tenant des rapports avec amendment_allocation_id d'une autre org
- Migration réelle depuis l'état précédent (36 entrées dans `__drizzle_migrations`)
- Test de montée de version réelle 0035 → 0036 via le runner Drizzle officiel
  (`drizzle-orm/postgres-js/migrator`) : création d'un dossier temporaire avec
  migrations 0001-0035 + journal tronqué, exécution du runner (35 entrées dans
  `__drizzle_migrations`), insertion de données préexistantes (booking, ligne,
  item, payment, refund LATE_PAYMENT_NO_BOOKING, refund EXTERNAL_REFUND,
  condition report, damage report), ajout de 0036 au dossier + mise à jour du
  journal, second passage du runner (36 entrées, 0036 apparaît exactement une
  fois identifiée par son hash Drizzle réel — pas par l'id auto-incrémenté),
  vérification des triggers G7M-A (XOR refund, cross-tenant), rerun du runner
  confirmant 36 entrées stables sans perte de données.

## Correctifs de compatibilité de types (schema → code existant)

Le passage de `refunds.payment_id` en nullable (XOR avec
`amendment_payment_id`) et l'ajout des statuts `FAILED_REQUIRES_MANUAL_ACTION`
et `SETTLED_OFF_PLATFORM` à l'enum `refund_status` ont nécessité trois
correctifs minimes dans `packages/core` pour préserver la compatibilité TypeScript :

1. **`handle-webhook.ts`** : guard nul sur `existingRow.paymentId` avant la
   jointure `paymentAttempts` — un refund `AMENDMENT_COMPENSATION` a
   `payment_id` NULL (il référence `amendment_payment_id`) et le projecteur
   legacy ne résout pas encore `amendment_payment_id`, donc il échoue fermé
   (fail-closed). Le traitement webhook complet pour les origines amendement
   est différé au lot webhook G7M.
2. **`read-models.ts`** : filtrage `isNotNull(bookingItemId)` sur les requêtes
   `conditionReports` et `damageReports` — les rapports sur allocation
   d'amendement (bookingItemId NULL) ne sont pas des rapports de booking item.
3. **`execute-compensation.ts`** : ajout des cas `FAILED_REQUIRES_MANUAL_ACTION`
   et `SETTLED_OFF_PLATFORM` au switch sur `refund.status` — ces statuts
   terminaux sont traités comme des échecs/résolutions durables.

## Vérifications

Dernier run complet (PostgreSQL 16 + PostGIS, `DATABASE_URL=postgresql://uttily:uttily@localhost:5432/uttily`) :

- `pnpm --filter @uttily/database test` : **778 tests passés, 0 échec, 0 skip** (15 fichiers, 581s)
- `pnpm --filter @uttily/core exec vitest run --no-file-parallelism` : **2180 tests passés, 0 échec, 0 skip** (84 fichiers, 1530s)
- Tests Core G7M-A ciblés (5 tests) : G7M-A-1 (refund historique), G7M-A-2 (refund amendement fail-closed),
  G7M-A read-models (rapports historiques), G7M-A compensation 33 (FAILED_REQUIRES_MANUAL_ACTION),
  G7M-A compensation 34 (SETTLED_OFF_PLATFORM) — tous passés
- `pnpm lint` : OK (exit 0)
- `pnpm typecheck` : OK (8 packages, exit 0)
- `pnpm format:check` : OK (All matched files use Prettier code style)
- `git diff --check` : OK (exit 0)

## Corrections de cette passe

Cette passe corrige les lacunes identifiées dans la livraison initiale de G7M-A :

1. **Triggers `booking_amendments`** : ajout de la validation INSERT (type → statut
   initial, booking CONFIRMED, hold_deadline pour SUPPLEMENT), ajout du trigger
   `prevent_booking_amendment_deletion` (BEFORE DELETE), renforcement du trigger
   de transition pour isoler les timestamps terminaux.
2. **Triggers `booking_amendment_lines`** : validation `source_booking_line_id`
   pour ORIGINAL (requis, même booking, même logical_line_id, même variante),
   NULL pour AMENDMENT, validation `pricing_snapshot` (objet JSON), CHECKs renforcés
   pour ADD (before_unit_price=0) et REMOVE (after_unit_price=0).
3. **Triggers `booking_amendment_allocations`** : statut initial PROPOSED, source
   block requis/interdit selon action, validation des blocks (type, org, item,
   booking), périodes effectives incluses dans l'amendement, rejet REMOVE → CONVERTED.
4. **Triggers `booking_amendment_segments`** : amendement doit être SUPPLEMENT,
   block HOLD doit être ACTIVE et non supprimé, période du segment = période du
   HOLD block, statut initial PROPOSED.
5. **Triggers `amendment_payments`** : `connected_account_id` et `customer_user_id`
   doivent correspondre au booking, montant positif non-nul, devise EUR,
   statut initial PENDING_PROVIDER, timestamps terminaux isolés, transitions
   conformes.
6. **Triggers `amendment_payment_attempts`** : `provider_idempotency_key` requis,
   statut initial PENDING_PROVIDER, `attempt_number` = max+1, transitions conformes.
7. **Triggers `refunds`** : montant cumulé ≤ montant du paiement, transitions
   conformes (PENDING → SUCCEEDED/FAILED, FAILED → FAILED_REQUIRES_MANUAL_ACTION,
   FAILED_REQUIRES_MANUAL_ACTION → SETTLED_OFF_PLATFORM), colonnes
   `settled_off_platform_*` immuables sauf pour SETTLED_OFF_PLATFORM.
8. **Triggers `condition_reports` / `damage_reports`** : validation de
   `amendment_allocation_id` appartient à la même organisation.
9. **CHECKs supplémentaires** : timestamps terminaux sur `booking_amendments`,
   `amendment_payments` ; `reconcile_after` sur `amendment_payment_attempts` ;
   colonnes `settled_off_platform_*` sur `refunds`.
10. **Snapshot columns `amendment_payments`** : ajout de
    `provider_payment_intent_id`, `provider_charge_id`, `provider_balance_transaction`,
    `failure_code`, `failure_message`, `succeeded_at`, `failed_at`, `cancelled_at`.
11. **Tests** : passage de 65 à 103 tests avec couverture positive et négative
    pour chaque règle de trigger ; `seedBooking` crée des bookings CONFIRMED ;
    `seedAmendment` fixe `created_at` pour tous les types ; test de montée de
    version réelle 0035 → 0036 ; tests DELETE interdit pour allocations et segments.
12. **Documentation** : correction du commentaire webhook (un refund
    `AMENDMENT_COMPENSATION` a `payment_id` NULL et le projecteur legacy
    ne résout pas encore `amendment_payment_id` — traitement différé au lot
    webhook G7M), mise à jour des compteurs (1871 lignes migration, 3830 lignes
    tests, 103 tests), statut corrigé.

## Fichiers modifiés (liste exhaustive)

| Fichier | Changement |
| --- | --- |
| `packages/database/drizzle/0036_g7m_a_amendment_schema.sql` | Triggers renforcés, CHECKs ajoutés, colonnes snapshot `amendment_payments` |
| `packages/database/src/schema.ts` | Colonnes `amendment_payments` ajoutées (snapshot provider, timestamps terminaux) |
| `packages/database/src/schema-g7m-a-amendments.test.ts` | 103 tests (positive/négatif pour chaque règle), upgrade test 0035 → 0036 |
| `packages/database/drizzle/meta/_journal.json` | Entrée 0036 ajoutée (migration Drizzle) |
| `packages/core/src/webhook-handler/handle-webhook.ts` | Guard nul sur `paymentId` pour les refunds `AMENDMENT_COMPENSATION` |
| `packages/core/src/fulfillment/read-models.ts` | Filtrage `isNotNull(bookingItemId)` pour les rapports sur allocation |
| `packages/core/src/compensation-execution/execute-compensation.ts` | Cas `FAILED_REQUIRES_MANUAL_ACTION` et `SETTLED_OFF_PLATFORM` au switch |
| `docs/implementation/g7m-a-amendment-schema.md` | Ce fichier (corrections) |
| `docs/implementation/agent-context.md` | Référence G7M-A ajoutée |
| `docs/implementation/backlog.md` | Statut G7M-A mis à jour |
| `packages/database/src/migrate.test.ts` | Compteur de migrations mis à jour (36) |
| `packages/database/src/schema-audit-log.test.ts` | Compteur de migrations mis à jour |
| `packages/database/src/schema-g7f-a-photos.test.ts` | Compteur de migrations mis à jour |
| `packages/database/src/schema-g7h-analytics.test.ts` | Compteur de migrations mis à jour |
| `packages/database/src/schema-g7p-b2-snapshots.test.ts` | Compteur de migrations mis à jour |
| `packages/database/src/schema-lot5.test.ts` | Compteur de migrations mis à jour |
| `packages/database/src/schema-lot6-documents.test.ts` | Compteur de migrations mis à jour |
| `packages/database/src/schema-lot6.test.ts` | Compteur de migrations mis à jour |
| `packages/database/src/schema-lot7-pricing.test.ts` | Compteur de migrations mis à jour |
| `packages/database/src/schema-lot7.test.ts` | Compteur de migrations mis à jour |

## Hors périmètre

- `getEffectiveBooking` (projection canonique)
- Création ou application métier d'un amendement
- Calcul de delta-segments
- Modification des inventory blocks
- Stripe, remboursement fournisseur, webhook/réconciliation
- Outbox worker, autorisation Web, route de paiement, UI
- Documents amendés, photos, analytics
- Packages ou lockfile
