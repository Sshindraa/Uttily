# ADR-039 — Effacement RGPD du compte utilisateur et scellement d'archive probatoire

**Statut :** Accepted

**Date :** 2026-09-04

**Relie à :** [ADR-006](ADR-006-clerk-oidc.md), [ADR-016](ADR-016-audit-log-append-only-enforcement.md), [ADR-028](ADR-028-back-office-uttily-and-support-v1.md), au lot 21-P1 (fondation RGPD), au lot 21-P1A (cockpit support), au dossier de décision [`docs/operations/21-p1b-scoping-dpo-003-004.md`](../operations/21-p1b-scoping-dpo-003-004.md) et aux décisions souveraines **`DPO-003`** et **`DPO-004`**.

---

## 1. Contexte

L'exercice du droit à l'effacement (« droit à l'oubli », article 17 du RGPD) sur une plateforme de location d'équipements soulève des contraintes juridiques et techniques majeures :

1. **Obligation légale de conservation comptable et fiscale (10 ans)** :
   L'article L. 123-22 du Code de commerce impose la conservation obligatoire des pièces justificatives comptables, factures et décomptes pendant dix ans. L'article 17.3.b du RGPD exclut expressément l'effacement lorsque le traitement est nécessaire au respect d'une telle obligation légale.

2. **Préservation probatoire civile pour la défense de droits (5 ans)** :
   L'article 2224 du Code civil dispose que les actions personnelles ou mobilières se prescrivent par cinq ans à compter de la date à laquelle le titulaire a connu les faits (litiges sur restitution de matériel, dommages cachés, contestation de caution). L'article 17.3.e du RGPD exclut l'effacement pour la constatation, l'exercice ou la défense de droits en justice.

3. **Immuabilité stricte du journal d'audit (ADR-016)** :
   La table `audit_log` dispose d'une clé étrangère `audit_log_actor_user_id_users_id_fk` avec `ON DELETE RESTRICT` et d'un trigger PostgreSQL bloquant toute mutation (`BEFORE UPDATE OR DELETE`). Une suppression dure SQL (`DELETE FROM users`) est donc formellement impossible et échouerait dès lors que l'utilisateur a déclenché la moindre action enregistrée.

4. **Annuaire d'identité externe (Clerk)** :
   Clerk est l'autorité d'identité et de session (ADR-006). Pour garantir que l'utilisateur ne puisse plus jamais s'authentifier ou réactiver sa session, la suppression de l'entité Clerk via son API backend (`users.deleteUser()`) doit être ordonnancée avec la neutralisation dans Uttily.

---

## 2. Décision

Uttily adopte un **modèle d'effacement par neutralisation d'identité, dissociation irréversible et scellement d'archive probatoire**.

### 2.1. Garde-fous préalables à l'effacement (Fail-Closed)

L'effacement d'un compte est immédiatement **rejeté** si l'une des conditions suivantes est constatée :
1. **Réservations en cours ou futures** : Le client possède au moins une réservation avec un statut `CONFIRMED`, `READY_FOR_PICKUP` ou `ACTIVE`.
2. **Holds de réservation actifs** : L'utilisateur a un brouillon avec statut `HELD` ou `PAYMENT_PROCESSING`.
3. **Propriétaire unique d'organisation active** : L'utilisateur détient le rôle `OWNER` exclusif d'une organisation possédant des équipements actifs ou des réservations futures. L'utilisateur doit préalablement désigner un autre propriétaire ou clôturer l'organisation.
4. **Idempotence** : Si le compte utilisateur est déjà neutralisé (`users.deleted_at IS NOT NULL`), l'opération réussit sans altération supplémentaire.

### 2.2. Neutralisation de l'identité dans `users`

Dans une transaction PostgreSQL unique et sérialisée :
- `deleted_at = NOW()`
- `email = 'erased-' || id || '@anonymized.uttily.local'` : valeur déterministe, unique, respectant la contrainte `users_email_not_empty`.
- `display_name = NULL`
- `oidc_subject = 'erased-' || id` : valeur neutralisée rompant tout lien avec Clerk et respectant la contrainte d'unicité `users_oidc_subject_unique`.
- `oidc_provider = NULL`
- `is_platform_admin = FALSE`
- `updated_at = NOW()`

### 2.3. Révocation des appartenances (`organization_memberships`)

Les éventuelles appartenances de l'utilisateur sont passées en statut `REMOVED` avec horodatage `updated_at = NOW()`.

### 2.4. Scellement probatoire (`privacy_probatory_seals`)

Une table dédiée `privacy_probatory_seals` fige l'acte de scellement et calcule les échéances de purge :
- `user_id` : référence immuable vers `users.id` (contrainte unique, un seul scellé par utilisateur).
- `sealed_at` : horodatage UTC de la prise d'effet.
- `civil_retention_until` : `sealed_at + interval '5 years'` (prescription civile Art. 2224 Code civil).
- `accounting_retention_until` : `sealed_at + interval '10 years'` (rétention comptable Art. L. 123-22 Code de commerce).
- `sealed_bookings_count`, `sealed_payments_count`, `sealed_documents_count` : instantané des volumes de pièces conservées sous scellé.
- `trigger_source` : `'SELF_SERVICE'` ou `'SUPPORT_REQUEST'`.
- `privacy_request_id` : référence optionnelle vers `privacy_requests(id)`.

### 2.5. Purge de l'identité externe dans Clerk

Dès la confirmation de la transaction locale, le serveur appelle l'API Clerk Backend :
`clerkClient.users.deleteUser(originalOidcSubject)`

Si l'utilisateur n'existe plus chez Clerk (code 404 / `ClerkAPIResponseError`), l'événement est considéré comme déjà accompli. Si l'appel échoue temporairement, l'utilisateur demeure de toute façon bloqué côté Uttily car le module d'authentification (`provisionUserFromOidc`) rejette strictement tout utilisateur portant `deleted_at IS NOT NULL` avec une erreur `AccountDeletedError`.

### 2.6. Journalisation d'audit immuable

L'entrée d'audit est consignée sans aucune donnée à caractère personnel :
- `action = 'PRIVACY_USER_ACCOUNT_ERASED'`
- `targetType = 'USER'`
- `targetId = user.id`
- `metadata = { erasedUserId, privacyRequestId, sealedBookingsCount, civilRetentionUntil, accountingRetentionUntil }`

---

## 3. Conséquences & Bénéfices

1. **Conformité RGPD intégrale** : Respect du droit à l'effacement (Art. 17) combiné aux exceptions légales légitimes (Art. 17.3.b et 17.3.e).
2. **Garantie probatoire** : Les pièces comptables et contrats restent intègres et opposables devant les tribunaux et l'administration fiscale sans risquer de corrompre l'arbre relationnel PostgreSQL.
3. **Sécurité d'accès** : Impossibilité totale de ré-authentification pour un compte effacé.
4. **Idempotence native** : Toute répétition ou rejeu de l'effacement est idempotent et sans risque de corruption.
