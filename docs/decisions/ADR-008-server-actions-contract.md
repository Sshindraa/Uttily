# ADR-008 — Contrat des Server Actions (Lot 2B)

- **Statut** : accepté
- **Date** : 2026-07-28

## Contexte

Le Lot 2B introduit des Server Actions Next.js pour le catalogue/inventaire. Les actions assemblent authentification, autorisation multi-tenant, validation d'input et appel au domaine. Next.js peut masquer les messages d'erreur en production ; la propagation brute des erreurs domaine/PostgreSQL n'est pas une API UI fiable.

Le domaine catalog levait jusqu'ici des `Error` génériques avec des messages français. Une action qui souhaite distinguer un conflit de slug d'une erreur de validation devrait analyser le texte du message (`message.includes('slug')`), ce qui est fragile et non typé.

## Décision

1. **Signature** : Les Server Actions de mutation retournent `ActionResult<T>` (`{ ok: true; data } | { ok: false; code; message; fieldErrors? }`). Les lectures se font via Server Components appelant directement le core (pas d'action).

2. **Codes d'erreur typés** : `ActionErrorCode` est une union fermée dans `@uttily/contracts`. Toute extension nécessite une décision documentée (ADR).

3. **Erreurs métier typées** : Le domaine catalog lève `CatalogError` (avec `code: ActionErrorCode`) au lieu d'`Error` générique. Les actions catchent `CatalogError` et mappent le code vers `ActionResult`. Pas de string matching sur les messages.

4. **Conflits PostgreSQL** : Les violations de contraintes uniques sont catchées par nom de contrainte (pas par message) et mappées vers `CONFLICT_SLUG`, `CONFLICT_SKU`, `CONFLICT_SERIAL`, `CONFLICT_IDEMPOTENCY`. Le helper `isUniqueViolation(err, constraintName)` vérifie le code SQLSTATE `23505` et le nom de la contrainte.

5. **Validation** : Manuelle à la frontière action (parseurs FormData explicites), pas de Zod. Les erreurs de validation produisent `fieldErrors`.

6. **Idempotence** : `transferInventoryItem` conserve sa clé d'idempotence stable (générée à l'affichage du formulaire, champ caché, réutilisée aux retries). Les autres mutations (create/update/publish/archive) ne sont pas idempotentes ; la protection contre le double-submit est côté UI (désactivation bouton via `useFormStatus`).

7. **organizationId** : Toujours injecté serveur (depuis le paramètre de route), jamais trusté du client.

## Raisons

- Éviter le string matching fragile sur les messages français.
- Permettre une UI déterministe (codes stables et typés).
- Ne pas exposer d'erreurs PostgreSQL brutes à l'utilisateur.
- Cohérence avec les conventions Lot 1 (validation manuelle, messages FR).
- Scope limité au contrat d'action (pas de pagination/composants qui relèvent du périmètre lot).

## Conséquences

- `@uttily/contracts` n'est plus vide (introduction `ActionResult`, `ActionErrorCode`, `FieldErrors`).
- Le domaine catalog lève `CatalogError` (refactor des fonctions existantes `createProduct`, `updateProduct`, `publishProduct`, `createVariant`, `updateVariant`, `deactivateVariant`, `deleteVariant`, `createInventoryItem`, `transferInventoryItem`).
- `AuthorizationError` est conservée pour les cas d'autorisation (mappée vers `FORBIDDEN` ou `NOT_FOUND` côté action).
- Le code `CONCURRENCY` a été retiré de l'union `ActionErrorCode` : aucun handling des deadlocks PostgreSQL (SQLSTATE `40P01`) n'est implémenté dans le domaine catalog. Le handling de la concurrence (deadlocks, retries optimistes) sera ajouté via ADR dans les lots futurs (réservations/paiements) où la concurrence sera plus critique.
- Les actions futures (réservations, paiements) réutiliseront ce contrat et étendront `ActionErrorCode` via ADR.

## Extension G4A — Frontière fulfillment

**Nouveaux codes** :

- `FULFILLMENT_INVALID_TRANSITION` : transition de statut booking invalide (INVALID_TRANSITION, TERMINAL_STATE, CONCURRENT_MODIFICATION, BOOKING_ITEM_MISMATCH)
- `FULFILLMENT_REPORT_NOT_ALLOWED` : rapport d'état ou dommage refusé par statut booking (REPORT_PHASE_NOT_ALLOWED, DAMAGE_REPORT_NOT_ALLOWED)

**Mapping FulfillmentError → ActionErrorCode** (fermé, pas de string matching) :

- VALIDATION / INVALID_CONDITION → VALIDATION
- BOOKING_NOT_FOUND / BOOKING_ITEM_NOT_FOUND → NOT_FOUND
- ORGANIZATION_MISMATCH / FORBIDDEN → FORBIDDEN
- IDEMPOTENCY_CONFLICT → CONFLICT_IDEMPOTENCY
- INVALID_TRANSITION / TERMINAL_STATE / CONCURRENT_MODIFICATION / BOOKING_ITEM_MISMATCH → FULFILLMENT_INVALID_TRANSITION
- REPORT_PHASE_NOT_ALLOWED / DAMAGE_REPORT_NOT_ALLOWED → FULFILLMENT_REPORT_NOT_ALLOWED
- IDEMPOTENCY_REPLAY_INVALID / UNKNOWN → UNKNOWN

**Confidentialité** : `fromStatus`/`toStatus` du `FulfillmentError` ne sont PAS exposés dans le message utilisateur. Le message de l'erreur Core est safe (messages contrôlés, pas de fuite DB). Les erreurs UNKNOWN produisent un message générique "Une erreur inattendue est survenue." sans fuite du message brut.

**Defense in depth** : le helper Web `requireFulfillmentOperatorOf` vérifie l'authentification et la membership côté web AVANT d'appeler les use cases Core. Les use cases Core refont le contrôle dans la transaction (`verifyFulfillmentMembership`). Le helper Web ne remplace jamais l'autorisation Core.

**Injection serveur** : `organizationId` est injecté par bind/closure (`action.bind(null, orgId)`), jamais lu du FormData. `actorUserId` vient du contexte authentifié (`user.id`), jamais du FormData. Les champs FormData frauduleux `organizationId` ou `actorUserId` sont ignorés.
