# G8B-3 — Cadrage du pilote vélo France / Lyon

- **Statut** : décisions produit acceptées ; partenaires et validations externes manquants
- **Date** : 2026-08-27
- **Périmètre** : pilote commercial loueurs professionnels
- **Relie à** : MVP scope, ADR-002, ADR-010, ADR-017, ADR-027

## 1. Positionnement territorial

Uttily se présente comme un service disponible à l'échelle de la France et ne
code aucune règle métier spécifique à Lyon. Lyon est toutefois la première zone
commerciale activée et la première zone dans laquelle Uttily cherche à constituer
une offre réelle.

Une ville n'est pas présentée comme disponible tant qu'aucun loueur professionnel
et aucun exemplaire physique publiable n'y sont configurés. Une recherche sans
offre peut afficher l'absence de résultat et les alternatives géographiques déjà
prévues, mais ne collecte pas d'email et ne crée pas de liste d'attente.

L'ouverture ultérieure d'une autre ville française est une activation de données
et d'offre, pas une réécriture du produit.

## 2. Client et usage initiaux

Le premier client cible est un particulier ayant un besoin ponctuel de location,
qu'il habite la région ou qu'il soit de passage. Le pilote ne distingue pas deux
produits séparés « touriste » et « habitant ».

Les abonnements client, les déplacements domicile-travail récurrents et les
réservations d'entreprise ou de flotte restent hors du pilote. Le parcours
nominal demeure : rechercher une période, réserver un équipement disponible
auprès d'un seul loueur, payer puis retirer en établissement.

## 3. Offre vélo pilote

Les deux familles initiales sont :

- vélos de ville ;
- vélos à assistance électrique.

Le VTT, le vélo de route et le vélo cargo ne sont pas nécessaires au Go initial.
Ils pourront être ajoutés comme catégories configurées lorsque l'offre partenaire,
les règles de sécurité, les accessoires et la politique de caution seront prêts.

La cible d'ouverture est de **20 vélos physiquement réservables**, répartis de
préférence entre **deux loueurs professionnels**. La répartition indicative est
d'environ dix vélos par loueur, sans imposer ce chiffre comme contrainte métier.
Les trois photos conformes, le prix, les horaires, le lieu de retrait et chaque
exemplaire physique restent obligatoires pour la publication.

## 4. Proposition faite aux loueurs pilotes

Le pilote ne facture ni abonnement, ni frais fixe d'accès, et n'impose aucune
exclusivité au loueur. Uttily est rémunéré uniquement lorsqu'une réservation est
confirmée et payée, au moyen de la commission versionnée déjà prévue dans le flux
Stripe Connect.

Cette décision ne fixe pas le taux, la base de calcul, la TVA sur la commission,
la répartition des frais Stripe ni le traitement contractuel des remboursements.
Ces valeurs restent bloquées par la validation finance/juridique décrite dans
`docs/product/lot5-finance-legal-validation.md`. Aucune valeur de démonstration
ou de staging ne peut devenir une valeur LIVE implicite.

## 5. État réel et critères de passage

Aucun loueur pilote n'est engagé à la date de cette décision. Uttily peut préparer
le contenu modèle, la collecte structurée des informations et la checklist
d'onboarding, mais ne peut pas déclarer le pilote commercial prêt.

Le contenu d'une organisation fictive reste strictement une fixture de
développement ou de staging. Il ne constitue jamais une offre commerciale.

Le passage au Go pilote exige au minimum :

1. deux loueurs professionnels onboardés, ou une décision explicite documentée
   autorisant un démarrage temporaire avec un seul ;
2. vingt vélos réels publiables et réservables à Lyon ;
3. un parcours TEST final avec les données représentatives de chaque loueur ;
4. les validations finance, juridique et RGPD nécessaires au LIVE ;
5. les configurations LIVE séparées, sans réutilisation des secrets TEST.

## 6. Découpage G8B-3

- **G8B-3A — cadrage commercial** : territoire, client, catégories, cible
  d'inventaire et proposition loueur — terminé par ce document.
- **G8B-3B — kit d'onboarding vélo** : fiche de collecte loueur, établissement,
  horaires, vélos, variantes, prix, accessoires, photos et responsables.
- **G8B-3C — contenu réel pilote** : création et vérification des deux loueurs et
  des vingt vélos ; bloqué tant qu'aucun partenaire n'est engagé.
- **G8B-3D — Go/No-Go LIVE** : finance, juridique, RGPD, Stripe LIVE,
  observabilité et smoke test final.
