# Accueil — première tranche de refonte (2026-08-31)

Périmètre demandé : reproduire la barre de la capture Airbnb fournie, en
remplaçant sa marque par `uttily`. Cette tranche de présentation s'inscrit dans
21-U1 / ADR-033 et n'exige aucune nouvelle décision structurelle.

- `HomeNavigation` est injectée uniquement sur `/` dans le shell client ; le
  reste de l'accueil, le footer et les autres routes conservent leur UI.
- La seconde itération remplace All, Homes, Experiences et Services par
  « Parcourir les lieux » (globe et chevron), et « Become a host » par
  « Créez votre annonce », selon la nouvelle capture. Le fond blanc est conservé.
- Le menu des lieux ouvre un lien vers la recherche existante permettant de
  choisir une destination ; aucune destination ni catégorie métier n'est inventée.
- Le H est un repère
  visuel provisoire, pas une initiale issue du compte connecté.
- Le menu donne accès aux parcours Uttily existants et conserve le contrôle
  Clerk connecté/déconnecté. Échap ferme chacun des menus et restitue le focus.
- La navigation passe sur deux lignes sur tablette/mobile. Les couleurs de la
  référence sont des tokens dédiés, sans changement de thème global.

## Choix de langue (troisième itération)

Le globe est désormais un bouton indépendant du menu « Parcourir les lieux ».
Il ouvre une fenêtre modale native avec arrière-plan assombri, focus contenu
dans la fenêtre, fermeture par la croix/Échap et restitution du focus au globe.
Les seules langues proposées sont `fr` et `en`. Aucune nouvelle région, devise
ou destination n'est activée. Le français utilise `/`, l'anglais `/?lang=en` ;
la sélection est portée par l'URL (pas de cookie ni de persistance globale).
L'accueil, la navigation, le footer et les liens recherche/locations suivent
cette locale. Les parcours professionnels restent inchangés.

Le composant UI `Dialog` conserve son comportement par défaut ; seul le mode
optionnel `nativeModal` utilise `showModal()` et verrouille le défilement du fond.

## Logo fourni (quatrième itération)

Le symbole vectoriel fourni par le porteur de produit (`logo_uttily_vector.svg`)
est servi localement depuis `/images/brand/uttily-logo.svg`, à côté du nom
« uttily », comme la composition symbole + nom de la référence Airbnb.
Les tracés, le noir et le dégradé bleu d'origine sont préservés. Seuls le
`viewBox` et les dimensions du canevas sont resserrés pour retirer les grandes
marges transparentes ; le fichier source fourni reste intact.
Le symbole fait 40 px sur ordinateur, 32 px sur mobile. Le lien d'accueil
conserve son nom accessible et sa langue ; l'image est décorative pour éviter
de faire lire deux fois le nom.

## Marque partagée dans les shells

Le composant partagé `components/brand/UttilyBrand` réutilise désormais ce même
logo dans la navigation d'accueil, le shell Client, le shell Uttily Pro
(sidebar et en-tête mobile) et l'en-tête Support interne. Les variantes `Pro`
et `Support` conservent leur suffixe textuel, tandis que le symbole, son texte
alternatif décoratif et le lien accessible restent centralisés. Les pages qui
héritent de ces shells affichent donc toutes la même marque sans dupliquer le
rendu du logo.

## Premier écran immersif — référence Peerspace

Le 2026-08-31, le premier écran sous la navigation reprend la composition de
la capture Peerspace : photographie pleine largeur, barre de recherche blanche,
grand titre sur deux lignes chevauchant le bandeau sombre inférieur.
`HomeNavigation` (structure et styles) reste inchangée, y compris le nom en Sora Regular.
Sur l'accueil uniquement, sa prop `sticky={false}` la laisse défiler avec la
page ; le filtre de recherche prend ensuite le relais et se fixe en haut de la
fenêtre (`searchBarPinned`). Les autres shells gardent leur comportement sticky.
La photo locale de Nick Page / Unsplash est une inspiration éditoriale, pas une
annonce Uttily. Sa provenance figure dans `public/images/home/README.md`.

Les trois entrées et le bouton Rechercher ouvrent un dialogue accessible qui
réutilise `SearchForm` et ses critères réels, avec focus sur le champ demandé.
Les options publiques sont chargées à l'ouverture uniquement par une action
serveur read-only ; aucune destination ni disponibilité fictive n'est injectée.
Le formulaire soumet les paramètres existants à `/{locale}/search`. Les erreurs
techniques ne sont pas exposées ; un lien de repli reste disponible en cas de
source indisponible ou de JavaScript désactivé. Les sections explicatives sous
le premier écran sont conservées. Aucune modification Core, paiement ou schéma.

## Navigation Uttily — direction originale

À la demande du porteur de produit, la navigation abandonne ensuite la
composition Airbnb : bandeau bleu nuit, bloc de marque blanc à angle découpé,
deux parcours hiérarchisés et menu de compte à quatre carrés. Le symbole fourni
et le mot-symbole en Sora Regular sont conservés ; le repère provisoire « H »
est supprimé. Les autres shells et la typographie globale restent inchangés.

« Parcourir les lieux » et « Mon espace » ouvrent des panneaux pleine largeur
mutuellement exclusifs. Ils se ferment par Échap (focus rendu au déclencheur),
clic extérieur ou choix d'un lien. Le globe reste indépendant et donne accès
aux deux langues existantes. Sur mobile, les utilitaires accompagnent le logo,
puis les deux parcours se répartissent sur une seconde ligne. Les panneaux
restent défilables dans la hauteur disponible.

Sur l'accueil, le header continue de défiler avec la page ; seule la barre de
recherche reste fixe une fois son point d'ancrage dépassé. Aucun nouveau
parcours métier, fournisseur ou service externe n'est introduit.

## Navigation allégée — direction adoucie après retour visuel

Le bandeau sombre et angulaire est abandonné après retour du porteur de produit,
qui le juge trop rigide. L'accueil retrouve un fond blanc aéré, avec le logo
original en Sora Regular, une entrée « Parcourir les lieux » sur fond bleu très
léger, un lien discret « Créez votre annonce », le globe indépendant et un accès
« Mon espace » arrondi. Aucun avatar fictif, numérotation ou slogan n'est ajouté.

Les deux grands panneaux sont remplacés par des menus compacts blancs à coins
arrondis, ancrés à leur déclencheur sur ordinateur et contenus dans la largeur
de l'écran sur mobile. Les liens, l'authentification Clerk, le choix FR/EN et
les fermetures Échap/clic extérieur sont préservés. Les autres pages et le
comportement de la barre de filtres au défilement ne sont pas modifiés.

### Hiérarchie de navigation

Le retour suivant signale que « Parcourir les lieux » flotte au milieu de la
barre. L'entrée est donc rapprochée du logo, à gauche, tandis que la création
d'annonce et les utilitaires restent groupés à droite. L'espace flexible
sépare ces deux usages, au lieu de centrer isolément un bouton. Le fond coloré
et l'icône de localisation sont retirés du déclencheur au repos pour distinguer
la navigation du formulaire de recherche. Le fond doux reste présent au survol
et à l'ouverture ; le menu se déploie aligné sur le bord gauche du déclencheur.
La disposition sur deux lignes et les menus contenus dans l'écran sont
conservés sur mobile.

### Barre de recherche harmonisée

La barre de recherche reprend les formes et couleurs de la navigation :
conteneur blanc arrondi, séparateurs fins entre critères, survol bleu léger et
bouton « Rechercher » arrondi bleu doux avec une loupe. Les libellés, Sora,
le dialogue et le formulaire de recherche existants sont conservés.
Sur mobile, les critères restent empilés dans une carte arrondie ; les marges
du mode fixe suivent désormais celles de la barre au repos (16 px sur mobile,
24 px sur tablette). Aucun changement du contrat de recherche ni du header.

### Recherche par intention — version suivante

La barre précédente et son formulaire en dialogue ont été remplacés par quatre
entrées (Destination, Équipement, Dates, Personnes), chacune avec son panneau.
Les résultats sont directement accessibles et utilisent la même barre. Le header,
le logo et Sora restent inchangés. Voir [home-search-next-level.md](home-search-next-level.md)
pour les comportements livrés et les limites explicites des recommandations de groupe.

### Archives des illustrations

Les quatre PNG de référence, provenant de la navigation publique de
https://www.airbnb.com/ consultée le 2026-08-31, ont été inspectés puis retirés
du checkout lors de la stabilisation Phase 0. Ils n’étaient pas utilisés par
l’interface et aucun asset tiers sans licence de redistribution ne reste dans
`apps/web/public/`. Prévoir uniquement des visuels Uttily sous licence avant
toute nouvelle réutilisation de cette direction.

Identifiants des sources `a0.muscache.com/im/pictures/` :

- All : `AirbnbPlatformAssets/AirbnbPlatformAssets-search-bar-icons/original/a811de29-114f-43a0-b8c5-698d4564bd04.png`
- Homes : `airbnb-platform-assets/AirbnbPlatformAssets-search-bar-icons/original/a32adab1-f9df-47e1-a411-bdff91b579c3.png`
- Experiences : `airbnb-platform-assets/AirbnbPlatformAssets-search-bar-icons/original/e47ab655-027b-4679-b2e6-df1c99a5c33d.png`
- Services : `airbnb-platform-assets/AirbnbPlatformAssets-search-bar-icons/original/3d67e9a9-520a-49ee-b439-7b3a75ea814d.png`
