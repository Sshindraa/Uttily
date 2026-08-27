# G8B-1 — Upload réel des photos produit

## Périmètre livré

- validation serveur des octets, du format, de la taille et des dimensions ;
- upload R2 privé par écriture conditionnelle ;
- états PostgreSQL `PENDING_UPLOAD`, `AVAILABLE`, `REJECTED` et `DELETED` ;
- rejeu idempotent par identifiant de photo et checksum ;
- remplacement ordonné (nouvelle photo puis ancienne supprimée) ;
- suppression physique R2 rejouable après le soft delete ;
- identifiant public séparé des IDs internes (migration 0039) ;
- route dashboard authentifiée et route publique contrôlée ;
- galerie publique et UI loueur accessible, responsive et utilisable au clavier ;
- tests unitaires de validation et tests PostgreSQL du flux upload/rejeu/
  remplacement/suppression.

## Garde-fous

Le navigateur n’a accès à aucun secret R2. Le serveur refuse un MIME qui ne
correspond pas aux octets réels et ne permet pas d’overwrite. Une offre ne peut
être publiée que si le gate PostgreSQL trouve au moins trois checksums distincts
sur des photos `AVAILABLE`. Aucun secret Stripe LIVE ni aucun fournisseur de
production n’est utilisé par les tests locaux.

La livraison publique passe par l’origine applicative contrôlée et ne révèle
pas le bucket R2. Le bucket reste privé ; `R2_PHOTOS_BUCKET_NAME` est la
configuration staging recommandée.

## Preuves locales

- `validate-product-photo.test.ts` : formats, dimensions, MIME incohérent et
  dépassement de taille ;
- `upload-product-photo.integration.test.ts` : PostgreSQL réel, stockage photo
  simulé sans réseau, rejeu idempotent, remplacement et suppression physique ;
- typecheck Core/Web et ESLint des fichiers touchés : verts.

## Validation staging

Le smoke test réel est validé le 2026-08-27. Le déploiement Vercel staging
`ae7ce01` utilise le bucket R2 privé EU `uttily-staging-photos` et un token
limité à ce bucket. Le compte Clerk TEST `uttily-staging-e2e+clerk_test@example.com`
est membre `Admin` de l'organisation de démonstration.

Sur `Kayak Lac d’Annecy`, déjà doté de trois photos valides, une image PNG
synthétique de 1200×900 a été envoyée depuis le dashboard. Le serveur l'a
acceptée, l'objet est visible sous le préfixe `product-photos/` dans R2 et la
fiche affiche quatre photos `AVAILABLE`. La galerie publique a ensuite chargé
les quatre images par la route applicative contrôlée, dont la nouvelle image en
1200×900. Aucun secret LIVE, fournisseur réel ou accès R2 public n'a été utilisé.

La preuve détaillée est conservée dans
`docs/implementation/g8b-1-staging-smoke-test.md`. Stripe LIVE reste interdit
tant que les verrous commerciaux, juridiques et de sécurité ne sont pas
explicitement clos.
