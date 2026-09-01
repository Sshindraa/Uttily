# Périmètre du MVP

## Objectif

Permettre à un client de trouver et réserver un équipement réellement disponible auprès d'un loueur professionnel, dans une destination donnée et pour une période donnée.

## Périmètre commercial fermé

Le MVP s'inscrit dans une plateforme outdoor spécialisée autour de quatre
univers : Cycle ; Kayak, canoë et pagaie ; Surf et glisse nautique ; Neige et
glisse. Les catégories camping, outdoor technique, sports généralistes,
outillage, jardin, événementiel, audiovisuel et construction sont hors
périmètre. La taxonomie et les statuts d'activation sont définis par
[le contrat canonique](equipment-taxonomy.md) et [ADR-035](../decisions/ADR-035-closed-outdoor-equipment-taxonomy.md).

## Utilisateurs

- **Client** : recherche, réserve, paie, récupère et restitue.
- **Propriétaire** : configure son entreprise et pilote son activité.
- **Employé** : prépare, remet, réceptionne et contrôle les équipements.
- **Administrateur Uttily** : assistance, contrôle et gestion des incidents.

## Inclus dans le MVP

1. Comptes, entreprises et rôles.
2. Établissements et horaires de retrait.
3. Catalogue de produits et exemplaires physiques (gating strict de publication : 3 photos conformes minimum par produit, ADR-020).
4. Prix par durée et périodes de blocage opérationnel (modèle journalier initial, plans horaires/forfaits préparés par ADR-018).
5. Recherche par destination, dates et catégorie avec carte interactive (bilingue FR/EN dès l'activation d'une destination, ADR-017/ADR-021).
6. Allocation d'exemplaires réels, hold temporaire (10 min) et réservation confirmée sans surbooking.
7. Paiement pour un seul loueur par panier via Stripe Connect (*destination
   charges* avec `application_fee_amount` calculé depuis le snapshot financier
   — commission legacy ou split 13/7 d'ADR-029).
8. Confirmation, contrat simple et emails transactionnels via outbox worker.
9. Retrait, retour, état du matériel et signalement de dommages.
10. Modifications financières d'une réservation confirmée avant retrait
    (amendements append-only : changement de dates, durée, quantité, variantes
    et allocations ; supplément via Stripe Elements, remboursement legacy sur le
    moyen d'origine ; les baisses portant un snapshot split restent fail-closed
    selon ADR-029/ADR-030 ; ADR-023, conception approuvée, implémentation
    terminée et fusionnée sur main).

## Explicitement hors MVP

- Abonnements mensuels payants pour les loueurs (SaaS gratuit pour capter l'inventaire, modèle 100 % commission).
- Dépôt de garantie / caution intégrée au paiement initial (gestion de la caution traitée séparément post-MVP).
- Location entre particuliers (C2C).
- Panier multi-loueurs.
- Livraison, casiers autonomes et points relais.
- Tarification dynamique avancée.
- Application mobile native.
- Assurance intégrée ou gestion automatisée des sinistres.
- Programme de fidélité, avis publics et recommandations IA.
- API partenaires et marque blanche.

## Indicateur de réussite

Une réservation ne peut jamais être confirmée pour un équipement indisponible, y compris lorsque plusieurs clients tentent de réserver simultanément le dernier exemplaire.
