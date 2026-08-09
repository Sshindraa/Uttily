# Vision long terme — Uttily, infrastructure mondiale de l'accès au matériel

## Décision

Le 7 août 2026, Uttily retient l'**option C** comme direction stratégique :

> Uttily devient progressivement le système d'exploitation mondial permettant
> de trouver, louer, exploiter et suivre des équipements physiques.

Cette vision combine trois produits complémentaires :

1. **Uttily OS** : le logiciel opérationnel des loueurs professionnels.
2. **Uttily Marketplace** : la distribution et la réservation de leur offre.
3. **Uttily Intelligence** : l'optimisation explicable du choix client, du parc,
   des prix et des opérations.

La trajectoire n'est donc ni une simple marketplace (« Airbnb du matériel »),
ni un SaaS isolé (« logiciel de caisse pour loueurs »). Uttily construit d'abord
un excellent système opérationnel, utilise ses données fiables pour alimenter
une marketplace, puis rend cette offre accessible à des partenaires et à des
agents logiciels.

## Pourquoi cette stratégie peut durer dix ans

Les interfaces et les modèles d'intelligence artificielle changeront. La valeur
durable d'Uttily doit venir d'actifs plus difficiles à reproduire :

- un inventaire d'exemplaires physiques réellement disponibles ;
- un historique transactionnel fiable de leur utilisation ;
- une connaissance structurée des équipements et de leurs compatibilités ;
- une preuve opérationnelle de l'état, de l'entretien et des mouvements ;
- une intégration profonde dans le travail quotidien des loueurs ;
- un réseau local de magasins, de partenaires et de clients ;
- des contrats machine-readable permettant à plusieurs interfaces de réserver
  sans contourner les règles transactionnelles.

L'IA exploite ces actifs ; elle ne les remplace pas. Uttily ne doit donc jamais
dépendre d'un modèle, d'un fournisseur ou d'une interface conversationnelle
unique pour conserver sa proposition de valeur.

## Les quatre avantages défendables

### 1. Equipment Graph

Uttily construit progressivement une connaissance structurée des équipements :

- catégories, variantes et caractéristiques techniques ;
- usages et activités compatibles ;
- niveau d'expérience, taille, poids ou âge des utilisateurs lorsque pertinent ;
- accessoires requis, recommandés ou incompatibles ;
- règles de sécurité et certifications ;
- contraintes de météo, de terrain et de transport ;
- équivalences et alternatives acceptables ;
- guides d'utilisation et d'inspection.

L'objectif à terme n'est plus seulement de répondre à « où louer un paddle ? »,
mais à une intention comme :

> Nous sommes deux débutants près d'Annecy demain matin, avec une voiture
> compacte et un budget de 80 €. Quel équipement disponible convient ?

Le résultat attendu est un ensemble cohérent, disponible et explicable, jamais
une suggestion inventée par un modèle sans validation sur les données Uttily.

### 2. Digital Equipment Passport

Chaque `InventoryItem` est destiné à devenir le jumeau numérique d'un exemplaire
physique, identifiable à terme par QR code, NFC ou identifiant interopérable.

Son passeport pourra réunir :

- identité, fabricant, modèle et numéro de série ;
- organisation et emplacement autorisés ;
- date d'acquisition et cycle de vie ;
- mouvements et nombre de locations ;
- heures ou jours d'utilisation lorsqu'ils sont mesurables ;
- photos de référence et rapports avant/après ;
- dommages, réparations, pièces et opérations de maintenance ;
- notices, consignes de sécurité et certifications ;
- informations de reconditionnement, transfert ou revente ;
- données de circularité requises par les futures réglementations applicables.

Ce passeport doit distinguer les faits vérifiés, les déclarations d'un acteur et
les inférences d'un système automatisé. Les droits d'accès varient selon le rôle :
client, loueur, réparateur, fabricant, assureur ou autorité.

### 3. Rental Intelligence

Uttily Intelligence aide le loueur à prendre de meilleures décisions :

- prévoir la demande par magasin, catégorie et période ;
- détecter une sous-capacité ou une flotte sous-utilisée ;
- proposer un transfert entre établissements ;
- recommander un achat, un entretien, un retrait de flotte ou une revente ;
- signaler des schémas de panne ou d'usure ;
- évaluer la lisibilité et la cohérence des forfaits ;
- suggérer un prix ou une réduction avec justification ;
- préparer les opérations du jour et prioriser les contrôles ;
- assister la rédaction, la traduction et le support.

Une recommandation de prix ne devient jamais automatiquement un prix publié :
le loueur garde le contrôle. Une détection de dommage ne devient jamais
automatiquement une facturation : elle prépare les preuves pour une décision
humaine et un processus contradictoire.

### 4. Agent-ready Commerce

Uttily doit pouvoir être utilisé par d'autres interfaces que son propre site :

- sites et applications des loueurs ;
- hôtels, campings, écoles et offices de tourisme ;
- widgets et solutions en marque blanche ;
- applications de voyage et de mobilité ;
- assistants et agents d'intelligence artificielle autorisés.

Un agent doit pouvoir, avec le consentement de l'utilisateur :

1. exprimer une intention structurée ;
2. rechercher une offre et vérifier sa disponibilité ;
3. obtenir un prix total et des conditions versionnées ;
4. proposer des alternatives explicites ;
5. créer un hold idempotent ;
6. demander l'approbation humaine requise ;
7. compléter ou annuler la réservation ;
8. recevoir les événements de suivi autorisés.

L'autorité reste dans les use cases Uttily et PostgreSQL. Un agent ne peut pas
contourner une autorisation, une contrainte de disponibilité, un snapshot de
prix, une politique ou une étape de confirmation humaine.

## Expérience client cible

La recherche évolue progressivement de la sélection d'un produit vers la
préparation d'une activité :

- intention, participants, niveau et préférences ;
- destination, horaire, durée et budget ;
- conditions locales et météo provenant de sources identifiées ;
- composition d'un pack compatible ;
- comparaison prix/durée/distance ;
- disponibilité physique réelle ;
- explication de la recommandation ;
- réservation transactionnelle avec approbation explicite.

Le client doit toujours pouvoir utiliser une interface classique, filtrer et
choisir manuellement. L'expérience conversationnelle est une surface
supplémentaire, pas une obligation.

## Expérience loueur cible

Uttily OS reste le point d'entrée de la stratégie. Il doit apporter une valeur
autonome, même sans réservation marketplace :

- catalogue, flotte et disponibilité ;
- prix par durée et magasin ;
- réservation, paiement et documents ;
- retrait, retour, dommages et maintenance ;
- pilotage multi-sites ;
- distribution sur plusieurs canaux ;
- recommandations opérationnelles et financières ;
- export et contrôle des données du loueur.

Le loueur choisit ses prix, ses règles, ses canaux et les recommandations qu'il
accepte. Uttily ne doit pas confisquer la relation commerciale ni rendre les
données opérationnelles captives.

## Réseau et écosystème futurs

Après validation du cœur OS + marketplace, Uttily pourra connecter :

- magasins et réseaux multi-sites ;
- écoles, bases de loisirs et stations ;
- hôtels, campings, conciergeries et offices de tourisme ;
- fabricants, distributeurs et réparateurs ;
- assureurs et prestataires de protection après cadrage juridique ;
- collectivités et entreprises ;
- canaux de distribution et agents logiciels.

Les paniers multi-loueurs, la location entre particuliers, l'assurance intégrée
et la distribution automatisée restent hors MVP. Chacun exige une décision
produit, juridique et architecturale distincte.

## Données à préserver dès aujourd'hui

Sans construire prématurément les fonctionnalités futures, les développements
actuels doivent préserver :

- l'identité stable des organisations, lieux, produits, variantes et exemplaires ;
- la distinction entre produit commercial et exemplaire physique ;
- l'historique append-only des faits importants ;
- la provenance et l'horodatage des observations ;
- des politiques, prix et contrats versionnés ;
- des événements métier structurés ;
- des API et contrats indépendants de l'interface ;
- le consentement, la minimisation et la séparation des données personnelles ;
- l'exportabilité et l'interopérabilité ;
- la possibilité de distinguer une décision humaine d'une recommandation IA.

Toute future recommandation ayant un effet matériel devra pouvoir conserver,
selon son niveau de risque : version de la règle ou du modèle, entrées factuelles,
date, résultat, niveau de confiance, explication, acteur validateur et éventuel
override humain. Le schéma exact sera défini par un ADR avant implémentation.

## Garde-fous IA

- Pas d'IA dans l'autorité transactionnelle de disponibilité.
- Pas de prix publié automatiquement sans règle produit approuvée et contrôle du
  loueur.
- Pas de facturation automatique d'un dommage sur une seule prédiction visuelle.
- Pas de décision de sécurité reposant uniquement sur une génération probabiliste.
- Pas de profilage opaque ni de discrimination tarifaire individuelle.
- Pas d'entraînement sur les données d'un loueur sans base légale et contrat
  explicites.
- Pas de dépendance irréversible à un fournisseur de modèle.
- Toute automatisation sensible est explicable, auditable, réversible et soumise
  aux autorisations serveur.

## Trajectoire

### Horizon 0 — MVP fiable

Réussir une réservation réelle : offre professionnelle, disponibilité,
tarification, hold, paiement, retrait, retour et preuve d'état.

### Horizon 1 — OS + marketplace dense

Faire d'Uttily l'outil quotidien des loueurs et densifier progressivement les
destinations, d'abord en France, puis en Europe.

### Horizon 2 — Intelligence opérationnelle

Construire l'Equipment Graph, enrichir le passeport des exemplaires et proposer
des recommandations explicables à partir de données opérationnelles fiables.

### Horizon 3 — Infrastructure de distribution

Ouvrir des contrats partenaires et agent-ready permettant la découverte et la
réservation depuis plusieurs surfaces, sans affaiblir les invariants Uttily.

### Horizon 4 — Réseau mondial et circularité

Optimiser les flottes, faciliter entretien, transfert, reconditionnement et
revente, puis étendre le réseau pays par pays selon les contraintes locales.

## Mesure de progression

Les métriques long terme complètent les métriques MVP :

- part de l'inventaire réellement synchronisée ;
- taux de disponibilité fiable ;
- utilisation et revenu par exemplaire ;
- temps opérationnel économisé au loueur ;
- taux d'acceptation et valeur mesurée des recommandations ;
- réduction des pannes et indisponibilités évitables ;
- proportion d'exemplaires disposant d'un historique exploitable ;
- réservations distribuées par les canaux partenaires ;
- rétention des loueurs et densité par destination ;
- durée de vie, réparation, transfert et réemploi du matériel lorsque mesurables.

## Règle de priorité

Cette vision guide les choix réversibles du présent, mais ne transforme pas les
fonctionnalités futures en périmètre MVP. Une fondation n'est ajoutée maintenant
que si elle sert le besoin actuel ou évite une impasse structurelle démontrée.
Chaque extension suit le processus normal : validation produit, ADR si
nécessaire, petit changement cohérent, tests et mesure de sa valeur réelle.
