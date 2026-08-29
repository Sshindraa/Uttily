# Lot 5 — Validation finance, juridique et Stripe Connect

- **Statut** : décision externe requise avant Stripe LIVE
- **Date** : 2026-07-30
- **Architecture technique** : ADR-010 proposée
- **Périmètre** : responsabilités financières, fiscalité, commission et
  conditions contractuelles du paiement de location

## 1. Décision technique déjà prise

Le MVP utilise un paiement Stripe Connect de type **destination charge** :

- un panier et un paiement concernent un seul loueur professionnel ;
- le PaymentIntent est créé par la plateforme Uttily ;
- le compte Stripe connecté du loueur est la destination ;
- la commission Uttily est transmise comme `application_fee_amount` ;
- le paiement est en EUR, par carte, avec capture automatique ;
- la confirmation repose sur le webhook signé ;
- une réussite tardive sans réservation déclenche un remboursement intégral
  idempotent, sans réallocation du matériel.

Cette fiche ne demande pas de redessiner le protocole technique. Elle demande les
valeurs et responsabilités nécessaires pour l'activer légalement en réel.

## 2. Effet financier à accepter

Avec une destination charge, Stripe débite généralement le compte plateforme des
frais de paiement, remboursements et litiges. Uttily peut inverser le transfert
vers le loueur lors d'un remboursement, mais elle conserve une exposition
opérationnelle et de trésorerie.

### Décision attendue A — responsabilité

Valider par écrit :

1. qui est le settlement merchant : Uttily ou le loueur connecté ;
2. si `on_behalf_of` doit désigner le loueur ;
3. qui supporte les frais Stripe ;
4. qui supporte remboursements, chargebacks, litiges et soldes négatifs ;
5. comment Uttily récupère contractuellement une somme avancée pour le loueur ;
6. quelles réserves de trésorerie et alertes sont requises.

## 3. Commission

Le business plan évoque des fourchettes, pas une règle approuvée. Le code exige un
montant déterminé et versionné avant paiement ; `null` ne sera jamais converti en
zéro.

### Décision attendue B — règle commerciale

Le choix produit interne du Chantier 22-B0 est documenté dans `ADR-029` et
implémenté sous la version serveur `split-13-7-v1` : base
`subtotal_amount_minor + mandatory_fees_amount_minor`, 13 % de frais loueur,
7 % de frais de service client, arrondi `HALF_UP_PER_COMPONENT`, aucun fixe.
Ce choix reste une proposition technique : `FIN-002` demeure bloqué tant que
Finance/Juridique n'ont pas signé la base, la date d'effet, la fiscalité, les
frais Stripe et les règles de remboursement.

Pour chaque offre pilote, fournir :

- base de commission : total TTC, sous-total, ou autre base définie ;
- taux en points de base et éventuel montant fixe ;
- minimum/maximum éventuel ;
- traitement des frais Stripe ;
- traitement de la commission lors d'un remboursement total ou partiel ;
- traitement TVA/facture de la commission Uttily ;
- date d'effet et version de la règle.

Le résultat doit toujours produire un `commission_amount_minor` entier, compris
entre zéro et le total payé.

## 4. Taxes, facture et rôle légal

Le Lot 4 conserve un total public TTC mais ne détermine pas sa décomposition
fiscale. Le Lot 5 ne peut pas confirmer avec `tax_status = UNDETERMINED`.

### Décision attendue C — termes fiscaux

Préciser pour le pilote :

1. qui vend juridiquement la location au client ;
2. qui émet la facture ou le reçu de location ;
3. si la taxe est `APPLIED` ou `NOT_APPLICABLE` ;
4. la règle permettant de calculer `tax_amount_minor` et, si pertinent,
   `tax_rate_bps` ;
5. les données fiscales du loueur nécessaires ;
6. le traitement fiscal de la commission Uttily ;
7. les mentions obligatoires sur confirmation, facture et reçu ;
8. la version et la date d'effet de la règle.

La règle ne peut pas modifier le total accepté dans le brouillon. Si le total
catalogue est incompatible, le catalogue doit être corrigé et un nouveau
brouillon créé.

## 5. Annulation et consentement

La fiche `docs/product/lot4-legal-validation.md` reste la source des questions sur
les politiques Flexible, Modérée et Ferme.

### Décision attendue D — contrat client

Valider :

- la conformité des politiques et de la fenêtre commerciale ;
- la base remboursable ;
- l'étape exacte d'affichage avant paiement ;
- le texte et le mécanisme de consentement ;
- les éléments de preuve à conserver ;
- les exceptions : défaut du loueur, force majeure et annulation par le loueur.

Le paiement LIVE exige une `legal_terms_version` active et la preuve de son
acceptation par le client.

## 6. Compensation d'un paiement tardif

### Décision produit technique

Si Stripe confirme un paiement mais que la réservation ne peut plus être créée :

- aucune réallocation ni conversion rétroactive ;
- remboursement intégral du montant payé ;
- inversion intégrale du transfert au loueur ;
- restitution intégrale de la commission Uttily ;
- opération idempotente et suivie jusqu'au statut fournisseur final ;
- intervention humaine et information du client si le remboursement échoue ou
  reste en attente.

### Décision attendue E — validation

Finance/juridique doit confirmer le délai de remboursement annoncé au client, le
message contractuel, le traitement des frais Stripe non récupérables et les
obligations de notification au loueur.

## 7. Caution

La caution n'est pas incluse dans le PaymentIntent de la location. Elle reste un
flux séparé et ne bloque pas les tests du paiement de location.

### Décision attendue F — stratégie pilote

Choisir explicitement l'une des stratégies documentées dans le modèle de données
(`CARD_AUTHORIZATION`, `EXTENDED_AUTHORIZATION`, `CARD_ON_FILE`, `INSURANCE`,
`EXTERNAL_DEPOSIT`, `NO_DEPOSIT`) et définir les catégories, montants, durées et
responsabilités. Cette décision fera l'objet d'un ADR séparé avant
implémentation de la caution.

## 8. Livrable attendu du validateur

La décision écrite doit contenir :

1. réponses A à F ;
2. pays et entités juridiques couverts ;
3. date d'effet ;
4. versions des règles ;
5. textes client/loueur approuvés ;
6. signataire juridique et signataire finance ;
7. conditions ou contrôles à réaliser avant mise en production.

## 9. Garde-fou d'environnement

Avant réception de cette décision :

- Stripe TEST peut être utilisé pour développer et valider le protocole ;
- aucune clé LIVE n'est activée dans l'application ;
- `PAYMENTS_LIVE_ENABLED` reste faux ;
- aucune valeur fiscale ou commission de test n'est réutilisée en production ;
- aucune réservation réelle n'est confirmée par ce flux.

## 10. Références

- [Stripe — destination charges](https://docs.stripe.com/connect/destination-charges)
- [Stripe — responsabilités selon le type de charge](https://docs.stripe.com/connect/charges)
- [Stripe — configuration des comptes connectés](https://docs.stripe.com/connect/accounts-v2/connected-account-configuration)
- [Stripe — onboarding](https://docs.stripe.com/connect/onboarding)
