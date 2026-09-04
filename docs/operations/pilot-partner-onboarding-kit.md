# Kit Officiel de Collecte & d'Onboarding — Partenaire Loueur Pilote (`PARTNER-001`)

**Version :** 1.0 — Pilote Commercial France (Zone Lyon)  
**Date d'émission :** 2026-09-04  
**Référence opérationnelle :** [`pilot-partner-readiness.md`](./pilot-partner-readiness.md) & [`live-operator-checklist.md`](./live-operator-checklist.md)  
**Destinataire :** Gérant & Responsable d'exploitation du loueur partenaire pilote  
**Émetteur :** Direction des Opérations & Pôle Juridique — Uttily SAS  
**Confidentialité :** Document à usage opérationnel strict. Les données recueillies sont destinées à la configuration de votre espace professionnel, à la génération déterministe de vos contrats de location opposables et au raccordement sécurisé de vos versements bancaires via Stripe Connect.

---

## ⚡ Parcours Autonome « Express & Léger » (Moins de 5 minutes chrono)

> 💡 **Conçu pour aller vite : Aucun formulaire lourd.**  
> Vous configurez votre magasin et vos vélos directement depuis votre tableau de bord Uttily (`/dashboard/[votre-magasin]/settings`).
> 
> **Seulement 4 informations légales sont obligatoires** pour que vos contrats de location soient valables face aux assurances et aux clients :
> 1. Votre **Raison sociale** (ou nom d'enseigne)
> 2. Votre numéro **SIREN (9 chiffres) ou SIRET (14 chiffres)**
> 3. L'**Adresse du siège social**
> 4. La **Ville**
>
> *Tous les autres champs (TVA, capital social, RCS) sont **facultatifs** ou pré-remplis automatiquement.*

---

## Volet 1 : Identité Légale du Magasin (Renseigné directement par le Loueur)

*À saisir dans votre espace Uttily : **Menu > Paramètres > Identité Entreprise**.*

| Champ | Statut | Comment le remplir en 30 secondes | Exemple |
| :--- | :---: | :--- | :--- |
| **Nom commercial (Enseigne)** | **Indispensable** | Le nom de votre magasin affiché aux clients | `Cycles des Berges` |
| **Raison sociale légale** | **Indispensable** | Nom légal de l'entreprise (ou nom/prénom si EI) | `CYCLES DES BERGES SAS` |
| **Numéro SIREN ou SIRET** | **Indispensable** | 9 chiffres (SIREN) ou 14 chiffres (SIRET) | `893 456 789 00012` |
| **Adresse du siège** | **Indispensable** | Numéro et rue du siège social | `15 Quai Victor Augagneur` |
| **Code postal & Ville** | **Indispensable** | Code postal et commune | `69003 Lyon` |
| **Forme juridique** | Optionnel | Menu déroulant simple (SAS, SARL, EI...) | `SAS` |
| **Numéro de TVA** | Optionnel | Laisser vide si franchise en base de TVA (art. 293 B) | `FR89893456789` ou *laisser vide* |
| **Représentant légal** | Optionnel | Nom et prénom du gérant / président | `Jean Dupont` |
| **Ville du RCS** | Optionnel | Ville de votre greffe (ou laisser vide) | `Lyon` |
| **Capital social** | Optionnel | Montant libéré (ou laisser vide) | `10 000 €` |

---

## Volet 2 : Établissement Physique & Point de Retrait (Magasin Pilote)

*Adresse où les clients viennent retirer et restituer les équipements loués.*

| Champ requis | Description / Format attendu | Données du Partenaire |
| :--- | :--- | :--- |
| **Nom du point de retrait** | Nom de la boutique / magasin | `[Ex: Cycles des Berges — Boutique Guillotière]` |
| **Adresse physique du magasin** | Adresse exacte de retrait | `[Ex: 15 Quai Victor Augagneur]` |
| **Code postal & Ville** | Commune et arrondissement | `[Ex: 69003 Lyon]` |
| **Coordonnées GPS (si connues)** | Latitude, Longitude | `[Ex: 45.7578, 4.8421]` |
| **Fuseau horaire** | Fuseau IANA | `Europe/Paris` |
| **Téléphone public du magasin** | Numéro affiché aux clients pour le retrait | `[Ex: +33 4 78 00 00 00]` |
| **Horaires d'ouverture habituels** | Plages d'ouverture par jour (Lundi - Dimanche) | • Lun-Ven : `09h00 - 12h30 / 14h00 - 19h00`<br>• Samedi : `08h30 - 19h30`<br>• Dimanche : `09h00 - 18h00` |
| **Consignes de retrait (Pickup)** | Instructions données au client à l'arrivée | `[Ex: Se présenter au comptoir atelier avec pièce d'identité et email de confirmation Uttily.]` |
| **Consignes de restitution (Return)** | Instructions pour le retour du matériel | `[Ex: Restitution propre 15 min avant la fermeture. Contrôle contradictoire de transmission et freins.]` |

---

## Volet 3 : Inventaire & Flotte d'Équipements Initiale

*Chaque équipement mis en location sur Uttily est tracé de manière unitaire avec son numéro de série afin de garantir l'absence totale de surbooking.*

> 💡 **Conseil de démarrage léger :** Inutile de saisir tout votre parc d'un coup. Pour lancer le pilote rapidement, **2 à 3 vélos représentatifs suffisent** (ex: 2 VAE + 1 vélo mécanique). Vous pourrez en ajouter d'autres à tout moment depuis votre tableau de bord.

### Tableau de Flotte (Exemple de saisie rapide)

| Réf. Interne | Catégorie | Marque & Modèle exact | Taille cadre | Numéro de Série Cadre (SN) | État physique initial | Accessoires fournis inclus |
| :---: | :--- | :--- | :---: | :--- | :---: | :--- |
| **BK-01** | Vélo électrique (VAE) | Moustache Samedi 28.3 | `M` | `H34892J8912` | `EXCELLENT` | Antivol U certifié, chargeur, panier avant |
| **BK-02** | Vélo électrique (VAE) | Moustache Samedi 28.3 | `L` | `H34892J8913` | `EXCELLENT` | Antivol U certifié, chargeur, panier avant |
| **BK-03** | Vélo de ville classique | Gazelle Esprit 7 vitesses | `S` | `GZ-992104` | `BON` | Antivol fer à cheval + chaîne |
| **BK-04** | Vélo de ville classique | Gazelle Esprit 7 vitesses | `M` | `GZ-992105` | `BON` | Antivol fer à cheval + chaîne |
| **BK-05** | Vélo Gravel / Route | Trek Checkpoint ALR 4 | `54` | `WTU-887410` | `NEUF` | Kit crevaison, pompe, antivol pliable |
| *BK-...* | *...* | *...* | *...* | *...* | *...* | *...* |

### Prérequis Visuel (Règle des 3 Photos Canoniques)
Pour chaque modèle de vélo référencé, 3 photographies nettes et sur fond neutre sont requises pour la publication :
1. **Photo 1 (Vue d'ensemble profil droit)** : Vélo entier visible, côté transmission.
2. **Photo 2 (Poste de pilotage & Compteur)** : Vue guidon, commandes et console (si électrique).
3. **Photo 3 (Détail transmission & Motorisation)** : Vue rapprochée dérailleur, moteur pédalier ou freins.

---

## Volet 4 : Grille Tarifaire & Conditions Commerciales

*Uttily applique le modèle officiel de commissionnement transparent **Split 13/7** (13 % commission loueur déduite de votre net de location, 7 % frais de service facturés au locataire).*

### 1. Tarifs Publics de Location TTC

| Modèle / Variante | Tarif 1/2 Journée (4h) | Tarif 1 Jour (24h) | Tarif Week-end (2j) | Tarif Semaine (7j) |
| :--- | :---: | :---: | :---: | :---: |
| **Vélo électrique urbain (VAE)** | `25,00 €` | `38,00 €` | `68,00 €` | `175,00 €` |
| **Vélo de ville mécanique** | `15,00 €` | `22,00 €` | `38,00 €` | `95,00 €` |
| **Vélo Gravel / Sport** | `30,00 €` | `45,00 €` | `80,00 €` | `210,00 €` |

### 2. Politique d'Annulation par Défaut
Veuillez sélectionner la politique applicable à vos équipements :
- [ ] **FLEXIBLE** *(Recommandé)* : Annulation avec remboursement 100 % jusqu'à **24 heures** avant le début de la location.
- [ ] **MODERATE** : 100 % jusqu'à 5 jours avant ; 50 % entre 5 jours et 24 heures.
- [ ] **FIRM** : 100 % jusqu'à 14 jours avant ; 50 % entre 14 jours et 7 jours.

*Note : Une période de grâce universelle de 24 h s'applique pour toute réservation effectuée plus de 7 jours à l'avance.*

### 3. Caution & Dépôt de Garantie
Conformément aux arbitrages du pilote :
- **Montant indicatif de caution** : `[Ex: 500 € pour VAE / 200 € pour vélo mécanique]`
- **Modalité de prise au comptoir** : Pré-autorisation bancaire par TPE physique ou chèque non encaissé conservé en boutique lors de la remise des clés.

---

## Volet 5 : Raccordement Bancaire (Stripe Connect) & Contacts d'Astreinte

### 1. Coordonnées Bancaires de Reversement (Stripe Connect Express)
Les fonds des réservations confirmées vous sont reversés directement sur votre compte bancaire professionnel :
- **Titulaire du compte :** `[Doit correspondre exactement à la raison sociale]`
- **IBAN professionnel :** `[FR76 ...]`
- **BIC / SWIFT :** `[XXXXXXXX]`
- **Email de l'administrateur Connect :** `[Email utilisé pour recevoir le lien d'onboarding Stripe]`

### 2. Contacts Opérationnels & Astreinte Magasin

| Rôle opérationnel | Nom & Prénom | Téléphone direct | Email direct |
| :--- | :--- | :--- | :--- |
| **Responsable de boutique / Comptoir** | `[Nom du responsable]` | `[+33 6 ...]` | `[email]` |
| **Référent technique / Atelier** | `[Nom du mécanicien/atelier]` | `[+33 6 ...]` | `[email]` |
| **Astreinte d'urgence (Samedi / Weekend)** | `[Nom du référent astreinte]` | `[+33 6 ...]` | `[email]` |

---

## Engagement de Conformité & Signature

> **Le Partenaire soussigné atteste de l'exactitude des informations d'immatriculation et des éléments de flotte renseignés dans ce dossier, confirme détenir une assurance Responsabilité Civile Professionnelle (RC Pro) en vigueur couvrant l'activité de location de cycles, et accepte les Conditions Générales Partenaires d'Uttily v1.**
>
> **Fait à :** \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_  
> **Le :** \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_  
> **Signature & Cachet commercial de l'entreprise :**
