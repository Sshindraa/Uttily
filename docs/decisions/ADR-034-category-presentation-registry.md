# ADR-034 — Registre de présentation des catégories

**Statut :** Accepted — tranche Phase 2 « Mes équipements ».

**Date :** 2026-09-01

## Contexte

Les routes historiques `/dashboard/:orgId/bikes` et leurs composants portent
encore des noms vélo alors que le read model charge déjà des produits,
variantes, exemplaires, tarifs, photos et statuts pour toute catégorie. Le
vélo reste la première catégorie à règles approfondies, mais les surfaces
« Mes équipements » doivent pouvoir afficher une autre catégorie sans copier
les libellés ni activer par erreur ses règles spécifiques.

## Décision

La présentation loueur utilise un registre frontend par `categorySlug`.
Chaque entrée peut déclarer :

- les libellés singulier et pluriel ;
- les caractéristiques explicitement affichables ;
- les sections spécifiques, notamment les slots photo et la sécurité vélo ;
- les libellés d’action principaux.

Toute catégorie absente du registre utilise obligatoirement la présentation
générique « équipement ». Le registre ne contient aucune règle de disponibilité,
de publication, de permission, de tenant ou de tarification : ces règles
restent dans Core et dans les gardes serveur existantes. Les règles photo et de
sécurité vélo restent activées uniquement par leur catégorie dédiée.

La projection de liste expose `categorySlug` afin de sélectionner cette
présentation sans changer les URLs, le modèle Produit → Variante → Exemplaire,
ni les contrats de mutation.

## Conséquences

- Les écrans liste et fiche peuvent accueillir `equipment` et les catégories
  inconnues avec un fallback déterministe.
- Les composants et routes historiques `bikes` restent compatibles ; leur
  renommage global est hors périmètre.
- Une nouvelle section ou caractéristique doit être ajoutée au registre et
  testée sans déplacer les règles métier dans le frontend.

## Hors périmètre

Aucune migration de base, aucun changement d’URL, aucune refonte d’onboarding
et aucune extension des règles de disponibilité, de maintenance ou de sécurité
ne fait partie de cette tranche.
