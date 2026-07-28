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
