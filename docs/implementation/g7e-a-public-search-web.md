# G7E-A — Recherche publique Web sans fournisseur externe

- **Statut** : implémenté et validé comme socle de G7E-B
- **Date** : 2026-08-09
- **Dépendances** : G7D-A, G7F-A2

## Résultat livré

Ce premier incrément G7E expose le moteur public exact dans l'application Web :

- page publique `/{locale}/search` pour `fr` et `en` ;
- formulaire accessible `DAY_RANGE` / `TIME_RANGE`, destination et catégorie ;
- liste des destinations strictement filtrée sur destination active, pays actif,
  non-suppression et traduction explicite dans la locale ;
- appel serveur à `searchPublicOffers` avec `PostgresPhotoPublicationGate` réel ;
- curseurs HMAC-SHA-256 signés par `PUBLIC_SEARCH_CURSOR_SECRET`, sans fallback ;
- résultats sans identifiants internes, quantité de stock, SKU ni données privées ;
- pagination keyset par lien signé ;
- endpoint `GET /api/public/search` pour la future relance depuis la carte ;
- erreurs publiques réduites à une union de codes fermée, sans détail SQL ;
- UI responsive FR/EN avec labels, focus visible, erreurs reliées aux champs et
  région de résultats annoncée.
- libellés EN explicites pour les slugs stables de la taxonomie MVP ; une
  catégorie future non traduite conserve son nom source jusqu'à l'introduction
  éventuelle d'un modèle de traductions de taxonomie.

Le choix de destination utilise les destinations canoniques en base. Cela rend
la recherche utilisable sans configurer prématurément Geoapify ou un autre
géocodeur, conformément à l'arbitrage produit.

## Hors périmètre de G7E-A

- carte déplaçable/zoomable et relance par viewport ;
- géocodage de texte libre ;
- élargissements géographiques et temporels présentés comme alternatives ;
- fiche produit publique et images livrées via CDN ;
- analytics G7H.

Ces éléments étaient nécessaires pour marquer G7E terminé. G7E-B choisit
l'adapter MapLibre et le fournisseur MapTiler, puis connecte les changements de
viewport à `/api/public/search` sans modifier les invariants Core ni faire de la
carte une autorité de disponibilité. Voir
`docs/implementation/g7e-b-public-search-map.md` et ADR-021.

## Configuration

`PUBLIC_SEARCH_CURSOR_SECRET` est obligatoire dès qu'une recherche est exécutée.
Il doit contenir au moins 32 octets et être distinct par environnement. Une
valeur absente ou invalide rend la recherche indisponible (fail-closed).

## Validation

- lint global : succès ;
- typecheck des 8 projets du workspace : succès ;
- suite Web : 189 tests passés, 100 tests PostgreSQL skippés selon le mécanisme
  standard lorsque `DATABASE_URL` n'est pas fournie à cette commande ;
- test PostgreSQL ciblé des filtres publics : 3/3 passés sur PostgreSQL 16 local ;
- build Next.js : succès, routes dynamiques `/{locale}/search` et
  `/api/public/search` présentes ;
- QA navigateur : FR, EN, bascule `DAY_RANGE`/`TIME_RANGE` et état « aucun
  résultat exact » vérifiés sur l'application locale.
