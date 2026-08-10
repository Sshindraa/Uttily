# Périmètre du MVP

## Objectif

Permettre à un client de trouver et réserver un équipement réellement disponible auprès d'un loueur professionnel, dans une destination donnée et pour une période donnée.

## Utilisateurs

- **Client** : recherche, réserve, paie, récupère et restitue.
- **Propriétaire** : configure son entreprise et pilote son activité.
- **Employé** : prépare, remet, réceptionne et contrôle les équipements.
- **Administrateur Uttily** : assistance, contrôle et gestion des incidents.

## Inclus dans le MVP

1. Comptes, entreprises et rôles.
2. Établissements et horaires de retrait.
3. Catalogue de produits et exemplaires physiques.
4. Prix simples par durée et périodes de blocage opérationnel.
5. Recherche par destination, dates et catégorie.
6. Allocation d'exemplaires, hold temporaire et réservation confirmée.
7. Paiement pour un seul loueur par panier.
8. Confirmation, contrat simple et emails transactionnels.
9. Retrait, retour, état du matériel et signalement de dommages.
10. Modifications financières d'une réservation confirmée avant retrait
    (amendements append-only : changement de dates, durée, quantité, variantes
    et allocations ; supplément via Stripe Elements, remboursement sur le moyen
    d'origine ; ADR-023, conception approuvée, implémentation non commencée).

## Explicitement hors MVP

- Location entre particuliers.
- Panier multi-loueurs.
- Livraison, casiers autonomes et points relais.
- Tarification dynamique avancée.
- Application mobile native.
- Assurance intégrée ou gestion automatisée des sinistres.
- Programme de fidélité, avis publics et recommandations IA.
- API partenaires et marque blanche.

## Indicateur de réussite

Une réservation ne peut jamais être confirmée pour un équipement indisponible, y compris lorsque plusieurs clients tentent de réserver simultanément le dernier exemplaire.
