# G8B-1 — Preuve du smoke test staging R2

## Référence

- Date : 2026-08-27
- Déploiement : Vercel `uttily-staging`, commit `ae7ce01`
- URL : `https://uttily-staging.vercel.app`
- Base : Neon branche `staging`, migration `0039` appliquée ; journal Drizzle à
  49 entrées
- Stockage : bucket R2 privé EU `uttily-staging-photos`
- Authentification : Clerk TEST, utilisateur
  `uttily-staging-e2e+clerk_test@example.com`, rôle `Admin` dans l'organisation
  de démonstration

## Parcours exécuté

1. Connexion Clerk TEST au dashboard staging.
2. Ouverture du produit `Kayak Lac d’Annecy` dans l'organisation `Uttily Demo
   Rental`.
3. Sélection d'une image PNG synthétique de test, 1200×900 pixels.
4. Upload depuis l'interface Photos du produit.
5. Vérification de l'état `AVAILABLE` dans le dashboard : trois photos
   existantes plus la photo envoyée, soit quatre photos valides.
6. Vérification du bucket R2 : objet `image/png` présent sous
   `product-photos/`, bucket toujours privé.
7. Ouverture de l'offre publique : les quatre images sont servies par
   `/api/public/product-photos/<publicPhotoId>` ; la nouvelle image est chargée
   avec ses dimensions 1200×900.

## Résultat

Le flux upload serveur → R2 privé → galerie publique contrôlée est validé.
La migration `0039` est présente et le chemin public n'expose pas le bucket ni
l'identifiant interne de la photo. Le fichier de test est synthétique et ne
contient aucune donnée personnelle.

Aucune clé Stripe LIVE, clé R2 publique ni fournisseur de production n'a été
utilisé pendant ce test.
