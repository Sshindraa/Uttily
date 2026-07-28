# Parcours utilisateurs de référence

## Client — recherche et réservation

1. Le client indique destination, période et catégorie.
2. Uttily retourne des produits réellement disponibles, avec prix, lieu et conditions.
3. Le client choisit un produit et ses éventuelles options.
4. Uttily crée un brouillon puis alloue les exemplaires dans une transaction.
5. Uttily crée un hold temporaire et ouvre le paiement.
6. Le paiement est confirmé par webhook.
7. Uttily convertit le hold en réservation, fige le prix et produit les événements de confirmation.
8. Le client reçoit confirmation, reçu, contrat et informations de retrait.

## Loueur — mise en ligne

1. Le propriétaire crée l'organisation et un établissement.
2. Il renseigne horaires, fuseau, politiques et moyens de retrait.
3. Il crée des produits, variantes et tarifs.
4. Il ajoute les exemplaires physiques avec leur état et identifiant interne.
5. Il rend un produit publiable seulement lorsque sa disponibilité et ses informations obligatoires sont complètes.

## Employé — retrait et retour

1. L'employé consulte les réservations prêtes au retrait.
2. Il contrôle l'identité, la réservation et l'état initial de l'équipement.
3. Il remet le matériel et la réservation passe à `ACTIVE`.
4. Au retour, il consigne l'état, les retards et éventuels dommages.
5. La réservation passe à `RETURNED`, puis `CLOSED` après contrôle opérationnel et financier.

## Webhook de paiement

1. Uttily vérifie la signature du webhook.
2. L'événement fournisseur est enregistré avec son identifiant unique.
3. Un événement déjà reçu ne produit aucun second effet.
4. Un paiement réussi confirme la réservation correspondante dans une transaction.
5. Les notifications et documents sont placés dans l'outbox.
