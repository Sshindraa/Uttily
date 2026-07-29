# Lot 4 — Fiche de validation juridique des politiques d'annulation

- **Statut** : en attente de validation juridique (requise avant Lot 5 / activation en production)
- **Date** : 2026-07-28
- **Émetteur** : produit (par délégation du porteur produit)
- **Destinataire** : validateur juridique (interne ou externe)
- **Blocage** : l'activation des politiques d'annulation en production et le Lot 5 (remboursement, confirmation) ne peuvent pas avoir lieu tant que cette validation n'est pas rendue. L'implémentation technique du Lot 4 n'est plus bloquée (ADR-009 acceptée pour le périmètre Lot 4 technique).
- **Périmètre** : politiques d'annulation produit du Lot 4. Les sujets fiscaux, Stripe Connect et la compensation des paiements tardifs sont hors périmètre (Lot 5).

## Contexte produit

Uttily est une plateforme B2B2C de location d'équipements de plein air (paddle, kayak, vélo, etc.). Les loueurs sont des professionnels. Le client réserve en ligne, paie en ligne, et retire l'équipement dans l'établissement du loueur. Le pilote cible une destination européenne, devise EUR.

La réservation passe par un brouillon, un hold temporaire de 10 minutes, puis un paiement. La confirmation de réservation intervient après le paiement (Lot 5). L'annulation peut survenir entre la confirmation et le retrait.

## Politiques d'annulation prédéfinies

Uttily propose trois politiques prédéfinies. La politique **Flexible** est la valeur par défaut du MVP. Le loueur choisit la politique applicable au niveau de l'organisation (`organizations.default_cancellation_policy_code`). La valeur par défaut est `FLEXIBLE`. Aucune politique par variante au MVP (post-MVP : politique personnalisée par variante).

### Flexible (par défaut)

| Échéance avant `customer_start_at` | Remboursement client | Frais d'annulation |
| --- | --- | --- |
| ≥ 24 heures | 100 % | 0 % |
| < 24 heures | 0 % | 100 % |

### Modérée

| Échéance avant `customer_start_at` | Remboursement client | Frais d'annulation |
| --- | --- | --- |
| ≥ 5 jours | 100 % | 0 % |
| ≥ 24 heures et < 5 jours | 50 % | 50 % |
| < 24 heures | 0 % | 100 % |

### Ferme

| Échéance avant `customer_start_at` | Remboursement client | Frais d'annulation |
| --- | --- | --- |
| ≥ 14 jours | 100 % | 0 % |
| ≥ 7 jours et < 14 jours | 50 % | 50 % |
| < 7 jours | 0 % | 100 % |

## Fuseau applicable

Toutes les échéances d'annulation sont évaluées dans le **fuseau IANA du lieu de retrait** (champ `time_zone` sur `locations`). Les instants sont stockés en UTC ; le calcul des bornes utilise la date civile locale du lieu.

Exemple : pour un retrait le 15 août à 10h00 à Paris (`Europe/Paris`), la borne de 24h de la politique Flexible est le 14 août à 10h00 heure de Paris.

## Fenêtre commerciale de 24 heures

Une **fenêtre d'annulation gratuite de 24 heures** s'ajoute après la confirmation de la réservation, **uniquement lorsque le retrait commence au moins 7 jours après la confirmation**.

- Si `customer_start_at - confirmed_at ≥ 7 jours` : annulation gratuite possible jusqu'à `confirmed_at + 24 heures`, quel que soit le seuil de la politique applicable.
- Si `customer_start_at - confirmed_at < 7 jours` : la fenêtre commerciale ne s'applique pas ; seule la politique applicable (Flexible, Modérée ou Ferme) s'applique.

Cette fenêtre ne s'appelle pas « droit de rétractation » (terme juridique à ne pas confondre avec une disposition commerciale). Sa qualification juridique est l'un des points à valider.

## Base de remboursement à valider

Le pourcentage de remboursement s'applique à une **base de remboursement** qui reste à définir juridiquement. Options à trancher :

- **A. Total client TTC** : `total_amount_minor` (prix de location + options + frais obligatoires, TTC). Le remboursement = `total_amount_minor * pourcentage`.
- **B. Prix de location hors options et frais** : `subtotal_amount_minor` (prix de location uniquement). Les options et frais obligatoires ne sont pas remboursés.
- **C. Prix de location + options, hors frais obligatoires** : `subtotal + options`, les frais obligatoires ne sont pas remboursés.
- **D. Autre base** à définir par le validateur juridique.

La base choisie doit être :

- affichée au client avant la confirmation ;
- figée dans le snapshot de politique d'annulation ;
- appliquée de manière déterministe par le moteur de remboursement (Lot 5).

## Questions pour la validation juridique

1. **Conformité des trois politiques** : les politiques Flexible, Modérée et Ferme sont-elles conformes au droit applicable (droit européen, droit local du pilote) pour une location de biens entre un professionnel et un consommateur ?
2. **Qualification de la fenêtre commerciale de 24h** : cette fenêtre est-elle juridiquement valable en tant que disposition commerciale ? Doit-elle être présentée comme un droit supplémentaire distinct de la politique d'annulation ?
3. **Base de remboursement** : quelle base (A, B, C ou D) est juridiquement requise ou recommandée ? Le validateur doit trancher.
4. **Frais obligatoires** : les frais obligatoires (ex: frais de service) doivent-ils être remboursés en cas d'annulation ? Selon quelle règle ?
5. **Affichage et consentement** : la politique d'annulation applicable doit-elle être affichée à une étape précise du parcours client (avant paiement, à la confirmation, etc.) ? Quel niveau de détail est requis ?
6. **Preuve de consentement** : quel mécanisme de preuve de consentement du client à la politique d'annulation est requis (case à cocher, enregistrement, etc.) ?
7. **Notification d'annulation** : une notification au loueur est-elle juridiquement requise à l'annulation ? Sous quel délai ?
8. **Cas particuliers** : existe-t-il des cas particuliers (force majeure, défaut du loueur, annulation par le loueur) qui nécessitent un traitement spécifique hors des trois politiques ?

## Informations à fournir au validateur

- Les trois politiques avec leurs bornes exactes (tableaux ci-dessus).
- Le fuseau applicable (IANA du lieu de retrait).
- La fenêtre commerciale de 24h (conditions d'application).
- La base de remboursement à définir (options A/B/C/D).
- Le contexte produit (B2B2C, loueurs professionnels, retrait en établissement, pilote européen, EUR).

## Décision attendue

Le validateur juridique doit rendre une décision écrite couvrant :

1. Conformité ou non-conformité de chaque politique (Flexible, Modérée, Ferme).
2. Modifications requises pour conformité (le cas échéant).
3. Qualification juridique de la fenêtre commerciale de 24h.
4. Choix de la base de remboursement (A, B, C ou D).
5. Règles d'affichage et de consentement.
6. Cas particuliers à traiter.

À réception de cette décision, les politiques d'annulation pourront être activées en production et le Lot 5 pourra intégrer le calcul de remboursement. L'ADR-009 est déjà acceptée pour le périmètre du Lot 4 technique.
