# ADR-027 — Résolution de destination local-first et première ville Lyon

- **Statut** : Accepted
- **Date** : 2026-08-27
- **Décideurs** : Porteur produit Uttily, engineering
- **Relie à** : ADR-017, ADR-021 ; G8B-2

## 1. Contexte

La recherche publique sait déjà filtrer une destination canonique stockée dans
PostgreSQL/PostGIS. G8B-2 doit ajouter une saisie naturelle et préparer le
géocodage sans rendre le parcours client dépendant d'un fournisseur distant.
Le développement se déroule d'abord entièrement en local ; aucun VPS n'est
requis pour ce lot.

## 2. Décisions produit

- Lyon est la première ville produit. Les autres villes sont activées
  explicitement, une par une, lorsque l'offre réelle est prête.
- L'autocomplétion doit pouvoir présenter des villes, quartiers, gares,
  aéroports et autres points d'intérêt canoniques. Une suggestion non activée
  ne permet pas de lancer une réservation.
- Une destination résolue est enregistrée avec un identifiant Uttily stable,
  ses libellés, son type, son pays, son centre et sa bounding box. Le fournisseur
  externe n'est jamais l'identité publique de la destination.
- Après la zone exacte, les élargissements géographiques suivront les paliers
  configurables 10 km, 25 km puis 50 km. Chaque palier est affiché comme une
  alternative explicite ; aucun résultat élargi n'est mélangé silencieusement
  aux résultats exacts. Cette mécanique sera implémentée dans un sous-lot dédié
  avec tests PostGIS.
- Les coordonnées canoniques sont revues au plus tard tous les 90 jours tant
  que le pilote n'a pas fourni de fréquence plus pertinente. Une correction
  manuelle reste possible et auditée.

## 3. Architecture local-first

PostgreSQL/PostGIS est l'autorité du registre de destinations et de la recherche
géographique. Le parcours public interroge d'abord ce registre local. Le service
de géocodage sert uniquement à découvrir ou rafraîchir des destinations dans un
flux d'administration ; il n'est pas appelé dans le chemin nominal d'une
recherche sur une destination déjà activée.

Cette séparation garantit qu'une panne, un quota ou une latence du fournisseur
de géocodage ne casse pas la recherche des destinations déjà publiées. Si un
enrichissement distant échoue, Uttily conserve la dernière version canonique
valide et signale l'échec aux opérations. Il n'existe aucun basculement opaque
vers une API publique sans garantie.

Le Core dépendra d'un contrat `GeocodingProvider` fermé et testable, pas d'un SDK
vendor. Les réponses externes sont validées puis converties avant toute écriture
dans le registre. Les requêtes libres des utilisateurs ne sont pas conservées
par défaut dans le cache canonique ni dans les analytics.

## 4. Choix du moteur : décision différée et benchmark local

Le fournisseur final n'est pas encore choisi. Le benchmark local comparera au
minimum :

1. le registre PostgreSQL/PostGIS Uttily pour les destinations activées ;
2. Photon sur données OpenStreetMap pour la couverture internationale ;
3. le service IGN/Géoplateforme pour la qualité des adresses et toponymes en
   France.

Addok reste une référence de comparaison France, mais son orientation adresse
et sa dépendance Redis n'en font pas l'autorité transactionnelle d'Uttily.
L'introduction de Photon/OpenSearch dans l'environnement local ou futur exige
un amendement accepté après mesure de la qualité, de la mémoire, du temps
d'import et des droits de réutilisation. Ce présent ADR n'introduit ni
OpenSearch, ni Redis, ni service de production.

Le corpus Lyon doit couvrir au minimum : accents, noms partiels, quartiers,
gares, aéroport, fautes courantes, homonymes et résultats hors zone. Les mesures
sont `top-1`, `top-3`, absence de faux positif, latence à chaud, empreinte disque
et mémoire, et comportement hors ligne.

## 5. Livraison incrémentale

- **G8B-2A** : saisie locale sur les destinations actives, tolérance aux accents,
  navigation clavier, Lyon dans la fixture locale — livré avec cet ADR.
- **G8B-2B** : corpus et benchmark local des adaptateurs, puis décision du moteur
  et des conditions de stockage.
- **G8B-2C** : ingestion/rafraîchissement canonique, cache durable et contrôle à
  90 jours.
- **G8B-2D** : élargissements PostGIS 10/25/50 km et présentation explicite des
  alternatives.

## 6. Conséquences

Le MVP reste simple et utilisable hors ligne pour les destinations activées.
L'ajout d'une ville est un acte contrôlé et réversible. Le compromis est que la
longue traîne mondiale n'est pas instantanément disponible : elle est enrichie
progressivement, ce qui est cohérent avec l'ouverture commerciale ville par
ville et évite de promettre une offre inexistante.
