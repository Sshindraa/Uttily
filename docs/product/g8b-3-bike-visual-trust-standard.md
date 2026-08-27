# G8B-3 — Standard visuel vélo et confiance publique

- **Statut** : direction produit acceptée ; implémentation partielle
- **Date** : 2026-08-27
- **Périmètre** : vélos de ville et vélos à assistance électrique
- **Relie à** : ADR-020, ADR-026, G8B-1, G8B-3B

## 1. Objectif

La fiche publique doit permettre au client de comprendre immédiatement ce qu'il
loue, auprès de quel professionnel et dans quel état général le matériel est
présenté. Uttily reprend le principe d'une présentation visuelle cohérente sans
transformer une photographie commerciale en preuve trompeuse sur l'exemplaire
physique finalement alloué.

Les références Airbnb confirment l'intérêt de photos lumineuses, cadrées,
récentes, combinant vues générales et détails, ainsi que de profils et guides
publics. Elles inspirent l'expérience, mais ne définissent aucune règle métier
ou juridique d'Uttily.

## 2. Standard photo vélo

### 2.1 Trois vues obligatoires

Pour un produit vélo, les trois emplacements attendus sont :

1. **Vue complète** : vélo entier, de profil côté transmission, cadré sans
   élément masquant le matériel ;
2. **Transmission** : pédalier, chaîne ou courroie, cassette et dérailleur si
   présent ;
3. **Freins et pneus** : détails suffisamment nets pour présenter le type et
   l'état général visible.

Pour un vélo électrique, des vues complémentaires de la batterie, du moteur, de
l'écran et du chargeur sont recommandées. Elles ne remplacent pas les trois vues
obligatoires tant qu'un nouvel amendement n'a pas défini des slots spécifiques
au VAE.

La taille, le modèle, les accessoires inclus et les caractéristiques électriques
sont renseignés dans les données structurées et les légendes ; une photographie
seule ne doit pas porter une information essentielle.

### 2.2 Consignes de prise de vue

- smartphone récent suffisant ; aucun appareil professionnel obligatoire ;
- lumière naturelle ou homogène, sans flash agressif ;
- arrière-plan rangé et contraste suffisant avec le vélo ;
- sujet centré, horizontal et non coupé ;
- résolution conforme aux limites d'ADR-020/ADR-026 ;
- aucun filtre qui modifie la couleur ou masque un défaut ;
- photo actuelle et remplacée lorsque le produit présenté change sensiblement ;
- défaut visible non retouché de manière trompeuse.

Pendant le pilote, la conformité du contenu et du cadrage est contrôlée par un
humain lors de l'onboarding accompagné. Il n'existe aucune promesse de détection
automatique de flou, de fraude ou de bon angle.

### 2.3 Limite de preuve

Les photos actuelles sont liées au produit, pas à chaque `inventory_item`. Elles
présentent donc un modèle commercial et ne doivent jamais être décrites comme
« photos du vélo exact qui vous sera remis ».

Les rapports d'état au retrait et au retour restent les preuves opérationnelles
liées à l'exemplaire réellement alloué. Des photos publiques par exemplaire
nécessiteraient une nouvelle décision de modèle, de rétention et d'expérience.

### 2.4 État d'implémentation exact

Le gate livré vérifie aujourd'hui le nombre de fichiers distincts, leur format,
leur taille, leurs dimensions et leur état R2. Il ne sait pas reconnaître la vue
complète, la transmission, les freins, les pneus, la netteté ou le cadrage.

La future UI guidée devra représenter des slots explicites côté serveur. Trois
fichiers génériques ne pourront pas être présentés comme trois vues contrôlées
tant que cette évolution n'est pas implémentée et testée.

## 3. Confiance envers le loueur

### 3.1 Identité publique

L'organisation professionnelle reste l'entité responsable et la source
principale de confiance. La présentation recommandée est :

> Vélo Lyon Centre — loueur professionnel vérifié
> Retrait à Lyon 2e · paiement sécurisé · matériel contrôlé avant retrait

Le terme retenu pour le MVP est **« loueur professionnel vérifié »**, pas
« SuperLoueur ». Ce badge signifie uniquement que les vérifications objectives
définies ci-dessous sont satisfaites ; il ne promet ni excellence, ni classement,
ni absence d'incident.

Critères techniques minimaux envisagés :

- organisation professionnelle active ;
- onboarding Stripe Connect terminé et compte autorisé à recevoir les paiements ;
- établissement public complet et retrait activé ;
- au moins une offre réellement publiable ;
- onboarding accompagné Uttily terminé.

Le calcul exact, l'audit et le retrait du badge doivent être conçus avant son
affichage. Aucun badge ne doit être renseigné manuellement comme simple texte
marketing.

### 3.2 Présence humaine facultative

La fiche peut ensuite présenter un responsable ou une équipe, par exemple
« Marc, responsable atelier », avec une courte introduction et une expérience
professionnelle déclarée. Le prénom, la photo et la biographie sont facultatifs,
publiés avec consentement explicite et modifiables ou retirable sans affecter
l'identité légale de l'organisation.

Le nombre d'années d'expérience ne devient pas « vérifié » sans justificatif ou
procédure définie. Le nom commercial de l'organisation demeure visible même si
la personne change.

### 3.3 Badge de performance différé

Un futur niveau de réputation pourra reposer sur des données réelles :
réservations honorées, disponibilité fiable, annulations, incidents et qualité
opérationnelle. Il n'est pas créé avant un volume minimal et une règle de calcul
versionnée. Les avis publics restent hors MVP.

## 4. Guide local

Les conseils locaux sont une différenciation pertinente, mais ne bloquent ni
l'onboarding, ni la publication, ni la réservation du pilote.

Après l'arrivée des premiers partenaires, un loueur pourra proposer des parcours
structurés comportant :

- titre et point de départ ;
- distance et durée indicative ;
- difficulté et surface ;
- type de vélo recommandé ;
- points d'intérêt ;
- date de dernière vérification ;
- avertissements de sécurité et lien vers les informations officielles utiles.

Le terme « spot secret » n'est pas une catégorie métier. Les itinéraires doivent
être publics, légalement accessibles, modérés et actualisables. Leur publication
nécessite une décision sur la responsabilité, la modération, le signalement et
la suppression de contenu obsolète.

## 5. Séquencement

1. conserver les gates techniques photo déjà livrés ;
2. implémenter après les blocages d'onboarding le guidage des trois vues vélo et
   leur validation serveur ;
3. afficher l'identité professionnelle avec des faits objectifs ;
4. concevoir le badge seulement avec un calcul auditable ;
5. expérimenter les parcours locaux après onboarding des premiers loueurs.

## 6. Références d'inspiration

- Airbnb, « How to take great photos for your listing » :
  <https://www.airbnb.com/resources/hosting-homes/a/how-to-take-great-photos-for-your-listing-687>
- Airbnb, informations affichées sur un profil hôte :
  <https://www.airbnb.com/help/article/3811>
- Airbnb, guidebooks publics : <https://www.airbnb.com/help/article/249>
