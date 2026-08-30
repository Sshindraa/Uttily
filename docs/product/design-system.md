# Uttily — fondation UX/UI 21-U0

## Principes

Uttily doit être professionnel, simple, rassurant et opérationnel. La surface
Client met en avant la confiance, le lieu, la disponibilité réelle et la clarté
du prix. La surface Pro réduit la charge cognitive et donne priorité aux actions
du jour. L'interface reste lisible dehors et sur mobile, accessible et moderne
sans devenir décorative.

Les textes utilisent des phrases courtes et des verbes d'action. Ils n'exposent
jamais d'exception, d'identifiant interne, de SKU, d'enum technique, de variable
d'environnement ou d'erreur fournisseur. Côté Client, on parle d'équipement,
de location, de dates et de lieu ; côté Pro, de vélo, de réservation, de flotte,
de retrait et de retour.

## Tokens

Les tokens CSS canoniques sont dans `@uttily/ui/tokens.css`. Ils couvrent les
couleurs sémantiques, la typographie (famille, tailles, graisses, interlignes),
les espacements, rayons, ombres, bordures, breakpoints, niveaux de profondeur et
durées/courbes d'animation. Les composants consomment ces variables et aucune
palette concurrente n'est introduite dans U0.

Breakpoints de référence : `40rem` (petit écran), `48rem` (tablette), `64rem`
(laptop) et `90rem` (desktop large). Les changements de mise en page sont
progressifs ; il ne doit pas exister de scroll horizontal global.

## Primitives

`@uttily/ui` expose le minimum réutilisable : `Button`, `LinkButton`,
`IconButton`, `Input`, `Textarea`, `Select`, `Field`, `Card`, `Badge`, `Alert`,
`EmptyState`, `Spinner`, `LoadingState`, `Skeleton`, `Dialog`, `Tabs`,
`PageHeader`, `SectionHeader` et `Icon`. Le package reste indépendant des
use-cases et de Next.js. Il ne contient pas encore de design system métier.

## Accessibilité et états

- Le contraste cible au minimum 4,5:1 pour le texte courant et 3:1 pour les
  grands textes, composants et indicateurs graphiques. Les contrôles utilisent
  les éléments HTML natifs, une cible tactile minimale de 44 px et un focus
  `:focus-visible` contrasté.
- `Field` relie label, aide et erreur avec `aria-describedby` ; les erreurs
  utilisent `role="alert"` et les changements non bloquants `role="status"`.
- `Dialog` utilise `aria-modal`, le bouton de fermeture, Escape, le focus à
  l'ouverture, le retour du focus à la fermeture et un cycle Tab borné.
- Les animations respectent `prefers-reduced-motion`. Les états prévus sont
  loading, empty, success, warning, error, disabled, retry et confirmation
  destructive. Aucun mode offline n'est implémenté dans U0.
- Les tables futures devront devenir des cartes ou rester scrollables dans un
  conteneur annoncé ; elles ne doivent pas imposer un scroll global.

## Shells de référence

La landing `/` est la référence Client U0 : elle démontre la marque, l'accès à
la recherche, les informations de confiance et les primitives de carte, bouton
et icône. Le cockpit `/dashboard/[orgId]` est la référence Pro : le shell pose
la navigation canonique `Accueil / Mes équipements / Réservations / Flotte /
Établissements / Revenus / Équipe / Paramètres`, avec section active, focus et
menu mobile utilisable. Catalogue, Inventaire et Planning top-level restent
des redirections de compatibilité et ne reviennent pas dans l'IA.

## Données et conventions de présentation

U0 ne crée aucune logique de prix, disponibilité, réservation, paiement,
remboursement, annulation, authentification, analytics ou base de données. Les
écrans existants continuent d'utiliser leurs helpers métier pour les montants,
dates, lieux et statuts. Si une prochaine surface exige une donnée absente,
elle doit être marquée `U1_DATA_DEPENDENCY` ou `U2_DATA_DEPENDENCY`, sans ajouter
un endpoint opportuniste.

## Plan de migration

### U1 — Client

1. Shell et accueil public — primitives : shell, PageHeader, Card, Button,
   LinkButton ; dépendance : contenu d'acquisition à valider.
2. Recherche et résultats — Field, Select, Tabs, Badge, Alert, Skeleton ;
   `U1_DATA_DEPENDENCY` : disponibilité, destination et pagination restent ceux
   des use-cases existants.
3. Fiche offre — Card, Badge, SectionHeader, Field ; pas de nouvelle donnée.
4. Checkout — Field, Alert, Button, LoadingState ; `U1_DATA_DEPENDENCY` :
   conserver les contrats de paiement existants.
5. Confirmation et compte — EmptyState, Card, Badge, PageHeader ; données
   Client existantes.
6. Détail de location et annulation — Alert, Dialog, Button ; aucune règle
   d'annulation nouvelle.

### U2 — Pro

1. Shell/navigation — déjà démontré par U0 ; retirer progressivement les styles
   locaux seulement lors de la migration d'une surface.
2. Cockpit — PageHeader, Card, Badge, Alert, SectionHeader ; use-case existant.
3. Réservations/planning — Tabs, Table shell, Badge, EmptyState.
4. Retrait/retour — Field, Button, Dialog, Alert.
5. Mes équipements — Card, Badge, PageHeader.
6. Flotte — Card, Tabs, Alert, EmptyState.
7. Établissements — Field, Card, SectionHeader.
8. Revenus — Card, Table shell, Badge ; montants via helpers existants.
9. Équipe/Paramètres — Field, Select, Button, Alert.

Les migrations U1/U2 restent séparées de U0 : elles peuvent adapter la copie et
les styles d'une surface, mais ne modifient pas les use-cases, contrats runtime,
états métier ou schéma.
