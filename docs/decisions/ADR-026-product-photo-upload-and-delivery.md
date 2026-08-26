# ADR-026 — Upload et livraison contrôlés des photos produit

- **Statut** : Accepté
- **Date** : 2026-08-27
- **Contexte** : G8B-1 — préparation du pilote commercial

## Décision

Les photos produit sont envoyées par une Server Action authentifiée du
dashboard loueur. Le navigateur ne reçoit jamais de credential R2 et n’écrit
jamais directement dans le bucket.

- Formats acceptés : JPEG, PNG et WebP uniquement.
- Limites serveur : 10 MiB maximum et 200–8000 px sur chaque dimension.
- Le fichier est validé sur ses octets réels, puis stocké avec une clé
  déterministe `product-photos/{organizationId}/{productId}/{photoId}`.
- R2 utilise `If-None-Match: *` : aucun overwrite silencieux n’est autorisé.
- La ligne PostgreSQL est créée en `PENDING_UPLOAD`, puis passe en
  `AVAILABLE` uniquement après écriture R2 réussie. Un rejeu avec le même
  `photoId` et le même checksum est un succès idempotent.
- Une suppression marque d’abord la ligne `DELETED`, puis supprime l’objet
  R2. Si la suppression physique échoue, un rejeu retrouve la ligne supprimée
  et retente la suppression physique.
- Un remplacement crée une nouvelle photo idempotente, puis supprime
  l’ancienne. L’ordre garantit qu’un produit publié ne perd pas son seuil de
  trois photos valides.
- Les pages publiques exposent seulement `product_photos.public_id` et une
  URL `/api/public/product-photos/{publicPhotoId}`. Cette route vérifie
  `PUBLISHED`, `AVAILABLE` et `deleted_at IS NULL`, masque le bucket R2 et
  porte des en-têtes de cache contrôlés. Les photos de brouillon passent par
  une route dashboard authentifiée et privée.

## Conséquences

Le champ `public_id` est ajouté à `product_photos` par la migration 0039. Le
bucket reste privé ; `R2_PHOTOS_BUCKET_NAME` permet d’utiliser un bucket dédié,
avec repli explicite sur `R2_BUCKET_NAME` pour le staging existant. Toute
configuration R2 manquante fait échouer l’opération : aucun stockage local ou
fournisseur réel implicite n’est utilisé.

La modération métier et les consignes spécifiques par catégorie restent hors
de ce ticket. La publication reste bloquée par le gate PostgreSQL de trois
photos distinctes valides.
