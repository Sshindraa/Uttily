# G8B-3B — Kit d'onboarding accompagné des loueurs vélo

- **Statut** : kit livré ; G8B-3B1 établissement publiable livré
- **Date** : 2026-08-27
- **Cible** : deux loueurs professionnels, vingt vélos réels à Lyon
- **Décision produit** : onboarding accompagné par Uttily pendant le pilote
- **Relie à** : `docs/product/g8b-3-bike-pilot-visual-trust-and-coach.md`

## 1. Principe opérationnel

Le pilote n'investit pas encore dans un tunnel d'onboarding autonome. Un membre
d'Uttily accompagne le propriétaire ou l'administrateur du loueur pendant deux
sessions courtes :

1. qualification de l'entreprise et collecte des informations publiables ;
2. configuration partagée du compte, vérification du catalogue et test d'une
   réservation Stripe TEST.

Le loueur conserve son propre compte et ses accès. Uttily ne demande jamais son
mot de passe, ses données de carte, ses identifiants bancaires ou ses documents
d'identité par email ou dans un champ libre. Les informations d'identité et de
paiement requises par Stripe sont saisies directement dans le parcours Stripe
Connect.

L'accompagnement ne contourne aucune autorisation : chaque écriture utilise les
actions serveur tenant-scoped existantes ou une future interface Uttily dédiée.
Aucune donnée partenaire réelle n'est insérée manuellement par SQL en staging ou
en production.

## 2. Fiche de collecte avant la première session

### Organisation et responsables

- raison sociale ;
- nom commercial public ;
- devise d'exploitation : EUR pour le pilote ;
- nom et email professionnel du propriétaire du compte ;
- membres à inviter et rôle attendu (`ADMIN`, `MANAGER` ou `STAFF`) ;
- confirmation qu'il s'agit d'un loueur professionnel.

Le SIRET, les représentants légaux et les coordonnées bancaires sont collectés
par Stripe Connect lorsque Stripe les exige. Leur copie dans Uttily nécessite un
besoin métier et un cadrage RGPD distincts.

### Établissement de retrait

- nom public de l'établissement ;
- adresse postale complète ;
- ville, code postal et pays ;
- fuseau IANA (`Europe/Paris` pour Lyon) ;
- coordonnées géographiques validées ;
- horaires de retrait et de retour pour chaque jour ;
- confirmation du retrait en établissement ;
- confirmation que l'adresse peut être affichée publiquement.

### Catalogue vélo

Une fiche est remplie par modèle commercial :

- famille : vélo de ville ou vélo à assistance électrique ;
- nom public et description factuelle ;
- variante : taille, type de cadre et caractéristiques utiles ;
- accessoires inclus, par exemple antivol, casque ou chargeur ;
- contraintes d'usage réellement appliquées par le loueur ;
- trois photos distinctes minimum, conformes aux règles d'upload ;
- prix en EUR, durée couverte et éventuels paliers multi-jours.

Une information absente n'est pas inventée. Les textes libres restent en
français tant que la politique de traduction FR/EN n'est pas décidée.

### Exemplaires physiques

Chaque vélo réservables possède :

- un SKU interne unique dans l'organisation ;
- une variante ;
- un établissement courant ;
- un état (`NEW`, `GOOD` ou `FAIR` pour être publiable) ;
- un statut `ACTIVE` ;
- un numéro de série seulement si le loueur souhaite le conserver dans Uttily ;
- une note interne facultative, jamais exposée publiquement.

Le nombre annoncé n'est jamais utilisé comme stock. Seuls les exemplaires
créés et disponibles dans PostgreSQL peuvent être alloués à une réservation.

## 3. Déroulé accompagné

### Session 1 — qualification et compte

1. confirmer le statut professionnel et le périmètre Lyon ;
2. créer l'organisation et le premier compte `OWNER` ;
3. définir le nom public et l'établissement ;
4. inviter les membres utiles avec le moindre rôle suffisant ;
5. lancer Stripe Connect TEST sans transmettre de donnée bancaire à Uttily ;
6. relever les informations manquantes et fixer le responsable de chacune.

### Session 2 — offre et preuve

1. créer les produits, variantes et exemplaires ;
2. uploader et vérifier les trois photos par produit ;
3. configurer les horaires et plans tarifaires ;
4. contrôler l'adresse, la carte et la recherche publique ;
5. exécuter recherche → hold → paiement TEST → confirmation ;
6. vérifier les documents, l'email, le dashboard et l'absence de surbooking ;
7. conserver le résultat dans une checklist datée, sans secret ni donnée de
   carte.

## 4. Checklist de publication d'un loueur

Un loueur est techniquement prêt uniquement si toutes les lignes sont vraies :

- [ ] organisation professionnelle active et nom public renseigné ;
- [ ] propriétaire actif et rôles de l'équipe vérifiés ;
- [ ] établissement public complet, géocodé, avec retrait et horaires ;
- [ ] compte Stripe TEST `ENABLED` pour le smoke test ;
- [ ] au moins un produit vélo avec variante active ;
- [ ] au moins trois photos valides par produit publié ;
- [ ] plan tarifaire EUR actif et compatible avec les horaires ;
- [ ] exemplaires physiques `ACTIVE` en état publiable ;
- [ ] offre visible dans la recherche Lyon aux dates réellement disponibles ;
- [ ] parcours TEST complet confirmé et effets worker vérifiés ;
- [ ] aucun secret LIVE utilisé ;
- [ ] validation juridique/RGPD explicitement séparée de la validation technique.

La cible commerciale globale de vingt vélos et deux loueurs est suivie au niveau
du pilote. Elle n'est pas transformée en contrainte de publication d'une
organisation individuelle.

## 5. Audit du dashboard existant

| Domaine | Couverture actuelle | Écart avant partenaire réel |
| --- | --- | --- |
| Organisation | création, rôles et invitations | édition du nom public à rendre explicite |
| Établissement | formulaire complet, coordonnées PostGIS, horaires, retrait et publication fail-closed | validation fonctionnelle à faire avec un loueur pilote |
| Catalogue | produit, catégorie, description, variantes | traduction du contenu libre non décidée |
| Photos | upload R2, validation et suppression | aucun écart bloquant technique connu |
| Exemplaires | création, état, statut, lieu, transfert | aucun écart bloquant technique connu |
| Tarification | moteur et schéma complets | aucune UI loueur pour créer et activer les plans tarifaires |
| Paiement | onboarding Stripe Connect et readiness | LIVE reste bloqué par finance/juridique |
| Recherche | Lyon, disponibilité et alternatives 10/25/50 km | calibration à faire avec l'inventaire réel |

## 6. Sous-lots techniques nécessaires

### G8B-3B1 — établissement publiable

Livré le 2026-08-27 : les formulaires autorisés saisissent et relisent l'adresse
complète, les horaires, les coordonnées validées, le retrait et l'état de
publication. Les rôles `OWNER`, `ADMIN` et `MANAGER` peuvent écrire ; `STAFF`
reste en lecture seule. La publication reste fail-closed côté Core et PostgreSQL
si l'adresse, les coordonnées, le retrait ou les horaires sont incomplets.
Les coordonnées sont écrites en `geometry(Point, 4326)` avec validation des
bornes latitude/longitude ; aucune migration n'est nécessaire.

### G8B-3B2 — plans tarifaires loueur

Ajouter un parcours dashboard minimal pour créer un plan EUR brouillon, ses
fenêtres, ses traductions FR/EN et ses éventuels paliers, puis l'activer après
validation serveur. Les règles d'immutabilité et de version du schéma restent
l'autorité ; aucun UPDATE manuel d'un plan actif.

### G8B-3B3 — readiness accompagnée

Afficher une checklist calculée côté serveur pour chaque organisation, avec
liens vers les éléments manquants. Ce read model ne publie rien et ne remplace
aucun gate PostgreSQL.

Ordre recommandé : G8B-3B1, G8B-3B2, puis G8B-3B3. Cet ordre permet de corriger
les données avant d'afficher leur synthèse.
