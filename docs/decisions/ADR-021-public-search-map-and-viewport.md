# ADR-021 — Carte publique et recherche par viewport

- **Statut** : Accepted
- **Date** : 2026-08-09
- **Décideurs** : Porteur produit Uttily, engineering
- **Relie à** : ADR-017, ADR-018, ADR-020 ; G7D-A ; G7E-A

> **Note de révision (2026-08-27)** : ADR-027 autorise pour G8B-2D des
> élargissements successifs 10/25/50 km, toujours séparés explicitement des
> résultats exacts. Le présent ADR continue de décrire le comportement livré
> avant cet élargissement.

## 1. Contexte

G7E-A expose la recherche publique exacte sur `/{locale}/search` et
`GET /api/public/search`. G7E-B ajoute une carte informative permettant de
déplacer ou zoomer la zone observée, puis de relancer explicitement la recherche
pour ce viewport. La destination canonique reste obligatoire : elle fournit le
repère produit, son libellé et la zone exacte de référence. La carte ne décide
ni de la disponibilité, ni de l'allocation, ni de la réservation.

Cette décision ne crée pas de migration et ne modifie pas le modèle de données.
PostgreSQL/PostGIS reste l'autorité des filtres géographiques, de l'inventaire et
de la disponibilité ; le hold transactionnel reste l'autorité de réservation.

## 2. Décisions

### 2.1 Adaptateur de carte et fournisseur de tuiles

L'interface Web utilise `maplibre-gl`, chargé uniquement côté navigateur par un
module client dynamique. Les styles et tuiles proviennent de MapTiler Streets
via l'URL de style publique construite avec `NEXT_PUBLIC_MAPTILER_API_KEY`.
La clé n'est jamais codée en dur, journalisée ou envoyée au Core. Le contrôle
d'attribution MapLibre est activé ; l'attribution fournie par le style reste
visible. `NEXT_PUBLIC_MAPTILER_API_KEY` est une variable publique injectée et
embarquée par Next.js au build : elle doit être configurée avant `next build` et
pour chaque déploiement Web qui active la carte. Elle ne doit pas être traitée
comme un secret runtime serveur. La clé doit être restreinte par domaine/referrer
et ses quotas doivent être configurés dans MapTiler.

MapLibre est l'adaptateur retenu plutôt qu'un SDK propriétaire : le contrat du
Core ne dépend d'aucun fournisseur et un futur adaptateur de style/tuiles pourra
remplacer MapTiler sans modifier la recherche PostgreSQL ni le read model public.
La clé `NEXT_PUBLIC_*` est une clé publique de navigateur, non un secret. Les
restrictions de domaine et les quotas relèvent de la configuration MapTiler et
de l'environnement de déploiement.

### 2.2 Échec du fournisseur et repli accessible

L'absence ou la forme manifestement invalide de la clé, l'absence de WebGL, une
erreur JavaScript, un échec de chargement du style ou des tuiles rendent la
carte indisponible. L'application affiche alors un message FR/EN non sensible
et conserve la liste SSR/accessible, qui est la présentation primaire. Aucun
serveur de tuiles de démonstration, endpoint OSM public ou autre fallback de
production n'est utilisé.

La carte est donc une amélioration progressive : son échec ne transforme pas
une recherche valide en erreur et ne masque pas les résultats déjà rendus.

### 2.3 Contrat de viewport

`SearchPublicOffersInput` accepte un champ optionnel :

```ts
viewport?: {
  kind: 'VIEWPORT';
  south: number;
  west: number;
  north: number;
  east: number;
}
```

L'absence de viewport conserve exactement le comportement canonique G7D-A :
bbox et centre de la destination active. La destination reste toujours résolue,
active, non supprimée, rattachée à un pays actif et traduite dans la locale
demandée, même lorsqu'un viewport est fourni.

Le serveur accepte seulement des nombres finis dans les plages latitude
`[-90, 90]` et longitude `[-180, 180]`, avec `south < north`. Les longitudes
`west <= east` décrivent une bbox normale ; `west > east` décrit une bbox qui
traverse l'antiméridien. `west === east` décrit une bande de largeur nulle et
reste valide : aucune largeur métier implicite n'est inventée. Toute autre
forme ou valeur est rejetée par `INVALID_INPUT`; elle ne retombe jamais sur la
bbox de la destination.

Pour un viewport, PostGIS applique sa propre bbox à `ST_Intersects`. Le centre
de distance est déterministe : latitude `(south + north) / 2`; longitude milieu
de l'arc ouest-est, avec l'arc traversant l'antiméridien calculé modulo 360.
La distance reste `DISTANCE_ASC` et le tuple keyset verrouillé
`(rawDistanceMeters, publicProductId, publicLocationId)`. Aucun rayon ni
élargissement automatique n'est introduit.

### 2.4 Curseurs et changement de zone

Le contrat public et le format de curseur passent en version 2. La signature
HMAC couvre la destination, la locale, l'intention, la catégorie, la version et
la zone canonique de recherche : un sentinel explicite pour la bbox destination
en l'absence de viewport, ou les quatre nombres normalisés du viewport fourni.
Un curseur d'une autre zone, ou un ancien format, produit `INVALID_CURSOR`.

La commande « rechercher dans cette zone » n'envoie jamais l'ancien curseur.
Elle démarre une nouvelle pagination liée au viewport ; le curseur retourné par
la nouvelle réponse peut ensuite être utilisé par « voir la suite ».

### 2.5 Exact et alternatives géographiques

Chaque offre possède `geographicMatch`, union fermée `EXACT |
VIEWPORT_ALTERNATIVE`. `EXACT` signifie que le point de l'établissement est
dans la bbox canonique de la destination, bornes incluses. Une offre trouvée
dans un viewport mais hors de cette bbox est `VIEWPORT_ALTERNATIVE`. En
l'absence de viewport, toutes les offres sont `EXACT`.

L'interface affiche ces deux valeurs dans des sections titulées séparément. Le
texte FR/EN précise qu'une alternative est hors de la destination sélectionnée
mais dans la zone de carte choisie. Les alternatives ne sont jamais fusionnées
silencieusement avec les résultats exacts. Le tri et la pagination restent ceux
du moteur Core, même si la présentation sépare les sections.

Les élargissements progressifs, alternatives temporelles, seuils/calibrations
automatiques, géocodage de texte libre et règles produit ne sont pas décidés
par cet ADR.

### 2.6 Accessibilité et interaction

La carte est déplaçable et zoomable via les interactions MapLibre et ses
contrôles de navigation clavier. Un déplacement ou zoom ne déclenche pas une
requête automatique. Après `moveend`, un contrôle explicite et focalisable
permet de relancer la recherche dans la zone visible. Pendant la requête, la
région de résultats expose `aria-busy` et un statut localisé ; les réponses
anciennes sont annulées ou ignorées.

La liste SSR reste utilisable sans JavaScript, sans WebGL et sans fournisseur de
carte. Les focus visibles, les titres sémantiques, le mobile-first et le respect
de `prefers-reduced-motion` restent obligatoires.

## 3. Sécurité, confidentialité et limites publiques

La route ne renvoie que les IDs publics, coordonnées des établissements déjà
publiables, informations de présentation et résultats de prix existants. Elle
n'expose aucun ID interne, stock, SKU, secret, clé fournisseur, SQL ou détail de
bloc. Le viewport est une préférence géographique explicite de la requête ; il
n'est pas persisté et n'est pas envoyé à un fournisseur de géocodage. La réponse
HTTP reste `Cache-Control: private, no-store`.

La carte n'est jamais consultée par le flux de hold. Un résultat public peut
devenir obsolète avant le clic ; la transaction PostgreSQL de réservation
revalide toujours l'inventaire et l'allocation.

## 4. Conséquences et portabilité

- `maplibre-gl` est une dépendance Web uniquement et ne doit pas entrer dans le
  bundle serveur Next.js.
- MapTiler est remplaçable derrière le module client ; la clé et l'URL de style
  sont de la configuration d'environnement, pas du contrat Core.
- La validation géographique est dupliquée volontairement à la frontière HTTP
  pour fournir un retour de formulaire clair, puis dans le Core pour conserver
  l'autorité serveur et le fail-closed.
- Toute évolution vers un fournisseur de géocodage, un CDN d'images, un
  élargissement automatique ou des alternatives temporelles exigera une
  décision et des contrats séparés.
