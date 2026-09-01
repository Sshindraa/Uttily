# ADR-034 — Registre de présentation des catégories

**Statut :** Accepted — tranches Phase 2 « Mes équipements » 1 et 2.

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

## Extension — tranche photos et maintenance

Les surfaces photos et maintenance réutilisent le même registre. Pour `bike`,
la fiche conserve le Photo Coach, ses trois slots canoniques et la section de
sécurité existante. Pour `equipment` et toute catégorie inconnue, la fiche
affiche un gestionnaire photo neutre, sans vocabulaire ni slots vélo. Le seuil
universel de trois photos valides avant publication reste contrôlé par Core.

La flotte physique, l'ouverture d'une maintenance, la liste des interventions,
le détail et la remise en service utilisent `categorySlug` uniquement pour les
libellés, icônes et sections de présentation. Les statuts, blocs
d'indisponibilité, transitions, permissions, isolation tenant et règles
d'anti-chevauchement restent ceux des projections et mutations existantes.

Les projections `listInventorySummaries` et `listMaintenanceCases` exposent
`categorySlug` par jointure de lecture avec `categories`. Cette extension ne
nécessite aucune migration.

## Conséquences

- Les écrans liste et fiche peuvent accueillir `equipment` et les catégories
  inconnues avec un fallback déterministe.
- Les composants et routes historiques `bikes` restent compatibles ; leur
  renommage global est hors périmètre.
- Une nouvelle section ou caractéristique doit être ajoutée au registre et
  testée sans déplacer les règles métier dans le frontend.

## Hors périmètre

Aucune migration de base, aucun changement d’URL, aucune refonte d’onboarding
et aucune extension de règle métier de disponibilité, de maintenance ou de
sécurité ne fait partie de cette tranche.
