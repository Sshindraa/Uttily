# G7E-B — Carte publique et recherche par viewport

> **Révision G8B-2D (2026-08-27)** : en l'absence de viewport choisi, la
> recherche publique applique désormais les paliers PostGIS 10/25/50 km et
> expose les alternatives dans des sections distinctes. Les règles ci-dessous
> décrivent le comportement viewport livré par G7E-B.

- **Statut** : implémenté ; élargissement G8B-2D livré le 2026-08-27
- **Date** : 2026-08-09
- **Dépendances** : G7D-A, G7E-A, G7F-A2
- **Décision** : [ADR-021](../decisions/ADR-021-public-search-map-and-viewport.md)

## Résultat

G7E-B étend `/{locale}/search` et `GET /api/public/search` avec une carte
MapLibre/MapTiler Streets progressive, tout en conservant la liste accessible
comme surface primaire :

- MapLibre est chargé uniquement côté client et utilise
  `NEXT_PUBLIC_MAPTILER_API_KEY` ; aucune clé ni tuile de démonstration n'est
  codée dans le dépôt.
- L'absence de clé, une clé manifestement invalide, l'absence de WebGL, un
  échec JavaScript, du style ou des tuiles affichent un message FR/EN et
  laissent la liste utilisable.
- Les contrôles MapLibre rendent la carte déplaçable, zoomable et pilotable au
  clavier. Un déplacement ne déclenche aucune requête automatique ; le bouton
  « Rechercher dans cette zone » est explicite et focalisable.
- La région de résultats expose `aria-busy` et un statut pendant la relance.
  Les requêtes précédentes sont annulées ou leurs réponses ignorées.
- Une relance de viewport supprime toujours l'ancien curseur côté client. La
  pagination keyset reçue est ensuite liée à cette nouvelle zone.

## Contrat serveur

`SearchPublicOffersInput.viewport` est optionnel et fermé :

```ts
{
  kind: 'VIEWPORT';
  south: number;
  west: number;
  north: number;
  east: number;
}
```

Les nombres doivent être finis, les latitudes dans `[-90, 90]`, les longitudes
dans `[-180, 180]` et `south < north`. `west > east` signifie un passage par
l'antiméridien ; `west === east` est une bbox de largeur nulle valide. Une zone
invalide retourne `INVALID_INPUT` et ne se rabat pas sur la destination.

Les paramètres HTTP sont explicites : `viewportSouth`, `viewportWest`,
`viewportNorth` et `viewportEast`. Ils sont parsés strictement comme des
décimaux finis ; une zone partielle, dupliquée ou inversée est rejetée. La
route conserve `private, no-store` pour les succès et les erreurs.

La destination active reste l'ancre obligatoire. Sans viewport, la bbox reste la
zone exacte et PostGIS ajoute les paliers 10/25/50 km autour du centre canonique.
Avec viewport, PostGIS utilise sa bbox pour `ST_Intersects` et le moteur calcule
la distance depuis son centre déterministe, y compris pour l'antiméridien. Le
tri et le tuple keyset restent `DISTANCE_ASC` et
`(rawDistanceMeters, publicProductId, publicLocationId)` sans `OFFSET`.

Les curseurs passent en contrat/format version 3. Leur HMAC couvre la zone
normalisée ou le sentinel de destination canonique. Un curseur d'un autre
viewport retourne `INVALID_CURSOR`.

## Sémantique d'affichage

Chaque offre contient `geographicMatch` :

- `EXACT` si le point de l'établissement est dans la bbox canonique de la
  destination, bornes incluses ;
- `RADIUS_10KM`, `RADIUS_25KM` ou `RADIUS_50KM` si elle est hors de cette bbox
  mais dans le palier correspondant autour du centre canonique ;
- `VIEWPORT_ALTERNATIVE` si elle est hors de cette bbox mais dans le viewport
  choisi.

La page sépare la zone exacte, chaque palier de rayon et le viewport choisi ;
elle explique en FR/EN que les alternatives sont hors de la destination
sélectionnée. En l'absence de viewport, une offre est classée exacte uniquement
si son point est dans la bbox canonique.

Il n'y a pas d'alternative temporelle, de
géocodage de texte libre, d'image/CDN, d'analytics G7H ou de changement de
booking dans ce lot. La carte est informative ; le hold PostgreSQL revalide
toujours l'allocation réelle.

## Fichiers principaux

- `packages/core/src/public-search/` : validation viewport, centre
  antiméridien, filtre SQL, classification et curseur v3 ;
- `apps/web/src/app/[locale]/search/` : résultats séparés, chargement
  MapLibre client-only et fallback accessible ;
- `apps/web/src/app/api/public/search/` et `apps/web/src/lib/public-search.ts` :
  parsing HTTP strict et relance no-store ;
- `.env.example` et `apps/web/package.json` : configuration publique MapTiler et
  dépendance `maplibre-gl` épinglée.

## Validation

- `pnpm --filter @uttily/web test` : 193 tests réussis, 100 ignorés ;
- tests Core ciblés avec PostgreSQL réel : 83 tests réussis sur 4 fichiers,
  dont 35 tests d'intégration de recherche publique ;
- `pnpm lint` et `pnpm typecheck` : réussis sur le monorepo ;
- `pnpm --filter @uttily/web build` : build Next.js de production réussi ;
- contrôle des artefacts : MapLibre est présent dans les chunks statiques
  client et absent de `.next/server` ;
- `git diff --check` : réussi.

La validation G8B-2D a ajouté 32 tests géographiques et 36 tests d'intégration
PostgreSQL : 68/68 réussis avec PostgreSQL local. `pnpm check:fast`, lint,
format et build monorepo sont également verts.

La validation locale a été exécutée avec Node.js 22.23.1 ; pnpm rappelle que le
projet déclare Node.js 24 ou supérieur, sans échec des contrôles ci-dessus.
