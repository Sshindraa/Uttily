# G8B-1 — Preuve du smoke test staging R2

> Ce document conserve la preuve historique du 27 août 2026. L’état courant
> vérifié le 30 août 2026 est décrit ci-dessous séparément afin de ne pas
> confondre ce test R2 avec la remise à niveau actuelle de staging.

## État courant vérifié le 30 août 2026

- Déploiement Web courant : `uttily-staging`, domaine
  `https://uttily-staging.vercel.app`, commit de merge `df6549b`.
- Base Neon `Uttily-dev/staging` : migrations `0040` à `0049` appliquées dans
  l’ordre, journal Drizzle à 49 entrées.
- Vérification publique : recherche Annecy du 10 au 11 juin 2030 fonctionnelle,
  une offre retournée, puis page de l’offre accessible avec photos, horaires et
  formulaire de réservation.
- Ce contrôle n’est pas une nouvelle preuve du parcours Clerk/Stripe/R2
  connecté ; aucun fournisseur LIVE n’a été activé.

## Référence

- Date : 2026-08-27
- Déploiement : Vercel `uttily-staging`, commit `ae7ce01`
- URL : `https://uttily-staging.vercel.app`
- Base lors du test historique : Neon branche `staging`, migration `0039`
  appliquée. Le journal annoncé à 49 entrées était incohérent avec cet état ;
  il a été corrigé le 30 août 2026 et contient désormais les migrations 0001 à
  0049.
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

Le flux upload serveur → R2 privé → galerie publique contrôlée était validé au
moment du test historique. La migration `0039` et les autres éléments de cette
section décrivent cet état daté ; ils ne constituent pas une preuve de
l’exécution actuelle du parcours connecté. Le fichier de test est synthétique
et ne contient aucune donnée personnelle.

Aucune clé Stripe LIVE, clé R2 publique ni fournisseur de production n'a été
utilisé pendant ce test.
