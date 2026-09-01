# Accueil — recherche par intention (2026-08-31)

## Lecture critique du document produit

Le document fourni fixe une surface à quatre entrées : Destination, Équipement,
Dates et Personnes. Il ne constitue pas une preuve de disponibilité des exemples
Annecy, VTT électrique, kayak double, accessoires inclus ou prix cités.

Les catégories et descendants actifs, les disponibilités, la sélection du plan
tarifaire et les alternatives géographiques existent dans Core. La nouvelle UI
les réutilise sans modifier le moteur, les prix ou le hold.

## Chantier 1 — expérience de recherche

- Quatre entrées, valeurs choisies visibles, panneaux dédiés accessibles.
- Recherche directe vers les résultats lorsque destination et dates sont valides.
  En cas de critère manquant, ouverture du seul panneau concerné : pas de nouveau
  questionnaire ni de date présumée.
- Destinations actives uniquement ; sélections récentes dans la session de l'onglet,
  quatre identifiants maximum. Aucun classement « populaire » sans mesure fiable.
- Équipement facultatif ; exploration et recherche remplacent le grand select.
- Les journées choisies sont inclusives dans l'UI, puis converties vers
  `endDateExclusive` pour Core. Les heures restent locales au lieu de location ;
  les conversions UTC, buffers et plans tarifaires restent exclusivement serveur.
- `peopleCount` est un contexte de présentation, pas une quantité réservée,
  une capacité vérifiée ou un prix de groupe. Borne technique d'interface 1–99,
  sans valeur contractuelle sur les réservations. La limite et la distinction
  sont explicites ; le moteur ne reçoit jamais ce champ comme `quantity`.

## Chantier 2 — compréhension contrôlée

- Synonymes déterministes FR/EN et recherche insensible aux accents.
- Suggestions limitées aux catégories actives renvoyées par le serveur.
- Hiérarchie issue des `parentId` existants, sans inventer de sous-catégorie.
- Une intention précise absente n'est pas convertie automatiquement en famille
  plus large. Les recherches larges suivent les descendants gérés par Core.
- Le contexte Personnes est conservé et modifiable sur les résultats ; les prix
  restent clairement présentés pour un équipement.

### Hors livraison : composition et recommandations V3–V5

La recherche publique ne possède ni capacité normalisée, ni accessoires inclus,
ni règles de compatibilité ou projection de disponibilité multi-exemplaires.
Ne pas fabriquer « meilleure configuration », « inclus » ou prix de groupe.

Avant ce moteur, valider : autorité de la capacité par variante, accessoires
obligatoires/inclus, configurations autorisées, classement explicable et prix
calculé pour chaque configuration. Conserver un seul loueur par panier et
l'allocation PostgreSQL transactionnelle. Cette évolution exige une ADR avant
schéma et implémentation ; le document UX seul ne tranche pas ces règles.

Les filtres contextuels (taille, autonomie, rigidité, niveau…) attendent également
des attributs fiables et des contrats de recherche dédiés. La géolocalisation
« Autour de moi » reste différée.

## Frontières

Présentation dans `features/search-intent`, shell et hero inchangés. Réutilisation
de l'action de lecture publique existante. Extension additive du read model de
catégories avec le parent existant ; aucune migration, aucun paiement, aucune
mutation de stock, aucun provider IA et aucune donnée analytique ajoutée.

## Validation locale

- Tests ciblés : 51 tests Web (état, synonymes, dates, personnes, accueil et
  navigation), plus 4 tests PostgreSQL isolés sur les choix publics et les
  relations parent-enfant actives. La base locale de développement est préservée.
- `pnpm test`, typage workspace et lint ciblé passent. Pas de matrice PostgreSQL
  complète ni d'action de publication pour ce changement de présentation.
- Parcours navigateur : Annecy → Vélos → 12–13 septembre → 4 personnes → résultats,
  puis recherche horaire le 12 septembre de 09:00 à 13:00. Fin journalière exclusive
  correcte et horaires locaux non convertis par le navigateur.
- Vérification de l'absence de correspondance VAE dans le catalogue local,
  sélection clavier de destination, historique récent, Échap/restauration du
  focus et navigation fléchée du calendrier. Aucun équipement fictif ajouté.
- Ordinateur et mobile : pas de débordement horizontal ; calendrier au-dessus
  du header, fermeture et validation accessibles pendant le défilement du panneau.
  La barre d'accueil se compacte à environ 126 px sur mobile lorsqu'elle devient
  fixe ; le header défile normalement. La carte des résultats est indisponible
  dans cet environnement local, sa liste et son message de repli restent utilisables.

La validation ne prouve pas la disponibilité d'une configuration de groupe.
La composition, les prix de groupe et les filtres d'attributs restent les chantiers
ultérieurs explicitement décrits ci-dessus.
