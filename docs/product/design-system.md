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

La famille typographique de référence est **Sora**, demandée le 2026-08-31.
La version variable normale (axe `wght` de 100 à 800) provient de Fontshare ;
elle est hébergée localement, préchargée et accompagnée de sa licence SIL OFL
1.1 dans `apps/web/public/fonts/sora/`. Aucun appel Fontshare n'est nécessaire
pour afficher l'interface. La police garde ses tracés d'origine et `font-display:
swap` permet une lecture immédiate pendant son chargement. Les axes inexistants
ne sont pas forcés : les variations de graisse passent par `font-weight`.

| Usage | Taille | Graisse | Interligne | Espacement |
| --- | --- | --- | --- | --- |
| Grand titre d'accueil | 36–64 px, 36–56 px sur mobile | 600 | 1,12 | −0,035 em |
| Titres de pages | 28 px | 600 | 1,25 | −0,02 em |
| Titres de sections et cartes | 20 / 24 / 32 px | 600 | 1,25 | −0,02 em |
| Texte courant | 16 px | 400 | 1,5 | normal |
| Introduction et texte long | 18 px | 400 | 1,65 | normal |
| Menus et labels | 14 px | 500 | 1,45 | normal |
| Boutons | 14–16 px | 600 | 1,45 | normal |
| Champs de formulaire | 16 px, minimum mobile | 400 | 1,5 | normal |
| Légendes | 13 px | 400–500 | 1,5 | normal |
| Marque et chiffres importants | selon le contexte | 700 | selon le contexte | normal |

Les anciens 800/900 sont ramenés à 700 et les graisses locales des interfaces
consomment les tokens communs. Les montants, dates et heures alignés utilisent
`--ut-numerals: lining-nums tabular-nums`, y compris les anciennes présentations
monospace. Les tokens sémantiques `font-body`, `font-ui`, `text-display`,
`text-control`, `text-label`, `text-caption`, `weight-heading`, `weight-action`,
`weight-label`, `leading-*` et `tracking-*` portent les réglages réutilisables.

Clerk reçoit explicitement Sora. Les éléments Stripe initiaux/suppléments et
Stripe Connect reçoivent la même famille et une feuille de police locale via
leur API de personnalisation ; leur rendu réel reste soumis au fournisseur.
Les ressources publiques `/fonts/sora/*` autorisent leur chargement cross-origin
pour ces cadres intégrés ; cette permission ne concerne aucune route métier.
Cette tranche concerne les interfaces Web, pas les emails ni les PDF
transactionnels dont la reproductibilité et les polices embarquées restent inchangées.

L'organisation frontend suit la frontière décrite par
[ADR-033](../decisions/ADR-033-frontend-boundaries.md) : les routes orchestrent,
les features portent l'expérience d'un domaine et `@uttily/ui` fournit les
primitives génériques. Une primitive ne connaît jamais une réservation, un vélo,
une organisation ou Stripe.

La palette de marque demandée le 2026-08-31 repose désormais sur **`#8CB6BF`**
et les nuances et teintes fournies par le porteur de produit. Elle remplace le
Navy/Cloud Mist précédent sur les interfaces Client, Pro et Support, ainsi que
les couleurs des modèles email. Le dessin du logo et la police Sora sont conservés.

| Rôle | Couleur | Usage |
| --- | --- | --- |
| Signature | `#8CB6BF` | carré central du logo, bouton de recherche |
| Survol signature | `#7EA3AB` | bouton de recherche au survol |
| Texte sur signature | `#1C2426` | icônes et textes sur les deux fonds précédents |
| Action principale / liens | `#465B5F` | boutons à texte blanc et liens sur fond clair |
| Action renforcée / focus | `#38484C` | survol sombre, focus clavier et état actif |
| Titres | `#1C2426` | hiérarchie forte |
| Texte courant | `#2A3639` | contenu principal |
| Texte secondaire / discret | `#465B5F` / `#546D72` | labels, aides et placeholders lisibles |
| Surface principale | `#FFFFFF` | cartes et champs |
| Fond de page | `#F3F7F8` | fond légèrement teinté |
| Survol doux | `#E8F0F2` | champs, menus et panneaux secondaires |
| Sélection douce | `#DCE9EB` | filtres, jours intermédiaires et badges d'information |
| Séparation décorative | `#D1E1E5` | cartes et séparateurs fins |
| Bordure de contrôle | `#627F85` | champs et boutons secondaires identifiables |
| Fonds sombres | `#0E1213` / `#1C2426` / `#2A3639` | surfaces sombres et support interne |
| Textes sur fond sombre | `#FFFFFF` / `#DCE9EB` / `#AECBD2` | hiérarchie inversée |

Le fond signature n'accueille pas de petit texte blanc : son contraste avec le
blanc est de **2,20:1**, contre **7,19:1** avec `#1C2426`. Les boutons sombres
`#465B5F` avec texte blanc atteignent **7,19:1** ; le texte discret `#546D72`
sur `#E8F0F2` atteint **4,77:1**. Les contrôles utilisent une bordure distincte
des séparateurs décoratifs. Les ombres et transparences dérivent de cette même
gamme, sans ajouter une autre teinte de marque.

`primary-*` reste le rôle d'action sombre lisible. `brand-teal` et `on-brand`
forment le couple signature clair/texte foncé ; ne pas les interchanger sans
vérifier le contraste. Les variables `home-*` historiques partagent maintenant
cette gamme. `support-*` garde une présentation sombre avec ces mêmes nuances.

Les couleurs success (`#247A4B`), warning (`#A76414`) et danger (`#B42318`)
restent réservées aux états métier ; elles ne servent pas d'accents décoratifs.
Les erreurs, avertissements et confirmations restent distinguables, avec leurs
libellés/icônes. Les fonds cartographiques et les photos gardent leurs couleurs.

Clerk reçoit les variables communes. Les apparences Stripe Elements et Connect
reçoivent les couleurs CSS résolues du site, car les variables CSS ne traversent
pas une iframe. Aucun appel de paiement ni changement d'authentification n'est
nécessaire pour cette personnalisation. Les PDF transactionnels restent inchangés.

Validation locale de cette palette : contrastes des paires de tokens, tests UI,
tests Web et notifications, suite rapide du workspace, typage Web et lint ciblé
validés. Accueil, panneaux de recherche et connexion contrôlés dans le navigateur,
dont le calendrier à 375 px. Aucun compte authentifié, paiement réel ou envoi
d'email n'a été utilisé pour la vérification ; les vues Pro/Support et les cadres
Stripe sont alignés par leurs variables partagées, sans validation de parcours LIVE.

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
