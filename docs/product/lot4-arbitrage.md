# Lot 4 — Compte rendu de décisions produit

- **Statut** : Décisions produit approuvées — validations juridique et finance en attente
- **Date de décision** : 2026-07-28
- **Autorité** : porteur produit par délégation
- **Statut produit** : approuvé
- **Statut juridique/finance** : en attente pour les sujets concernés
- **Prérequis** : aucune implémentation du Lot 4 avant acceptation de l'ADR-009.

## Règles déjà verrouillées (non négociables)

- Montants en entiers (`amount_minor`) en unités mineures, devise ISO 4217 explicite.
- PostgreSQL est l'autorité transactionnelle ; allocation immédiate des exemplaires.
- Hold temporaire avant paiement ; idempotence sur création de hold et de paiement.
- Snapshot de prix immuable après confirmation (montants, taxes, commission, conditions, politique d'annulation).
- Panier mono-loueur ; retrait en établissement uniquement.
- Loueurs professionnels uniquement.

## Sources d'inspiration (non normatives)

Les principes de transparence des prix, de politiques prédéfinies et de fuseau local s'inspirent d'Airbnb. Ces sources ne constituent ni une dépendance normative ni une justification juridique pour Uttily.

- Prix total visible : https://news.airbnb.com/total-price-display-is-now-standard-globally/
- Présentation des politiques d'annulation : https://www.airbnb.com/help/article/4052
- Politiques proposées aux hôtes et fuseau local : https://www.airbnb.com/help/article/475
- Composition du prix : https://www.airbnb.com/help/article/125
- Devises : https://www.airbnb.com/help/article/95

---

## Décision 1 — Politiques d'annulation prédéfinies

**Décision** : Uttily propose trois politiques prédéfinies. La politique **Flexible** est la valeur par défaut du MVP.

**Source** : La politique applicable est choisie au niveau de l'organisation (`organizations.default_cancellation_policy_code`), pas par variante. Valeur par défaut : `FLEXIBLE`. Choix parmi `FLEXIBLE | MODERATE | FIRM`. Les définitions des politiques (bornes, pourcentages, version) sont versionnées côté domaine. Au moment du brouillon, le snapshot copie `policy_code`, `policy_version` et le fuseau IANA du lieu (`timezone`). Aucune politique par variante au MVP.

**Flexible** (par défaut) :

- Annulation au moins 24 heures avant `customer_start_at` : 100 % remboursé.
- Annulation moins de 24 heures avant : 0 % remboursé.

**Modérée** :

- Au moins 5 jours avant : 100 % remboursé.
- Entre 24 heures incluses et moins de 5 jours : 50 % remboursé.
- Moins de 24 heures : 0 % remboursé.

**Ferme** :

- Au moins 14 jours avant : 100 % remboursé.
- Entre 7 jours inclus et moins de 14 jours : 50 % remboursé.
- Moins de 7 jours : 0 % remboursé.

**Fenêtre commerciale** : Ajout d'une fenêtre d'annulation gratuite de 24 heures après la confirmation lorsque le retrait commence au moins 7 jours plus tard. Cette fenêtre ne s'appelle pas « droit de rétractation » (terme juridique à ne pas confondre).

**Fuseau** : Toutes les échéances d'annulation sont évaluées dans le fuseau IANA du lieu de retrait.

**Snapshot** : La réservation conserve un snapshot de la politique applicable comprenant au minimum : `policy_code`, `policy_version`, `timezone`, `confirmed_at`, `customer_start_at`, échéances absolues calculées, pourcentages de remboursement, et base de remboursement (lorsque celle-ci sera validée juridiquement).

**Motif** : Trois politiques prédéfinies couvrent les besoins du pilote sans nécessiter de configuration personnalisée. La politique Flexible par défaut réduit la friction au démarrage. L'inspiration Airbnb guide la transparence et le fuseau local.

**MVP** : Trois politiques prédéfinies, Flexible par défaut, fenêtre commerciale de 24h, fuseau IANA du lieu.

**Reporté** : Politiques personnalisées par loueur, configuration fine.

**Réserve juridique/finance** : La conformité juridique des politiques et la définition exacte de la base remboursable restent à valider avant activation en production. La politique produit est approuvée, mais sa conformité juridique n'est pas présumée.

---

## Décision 2 — Prix transparent et TTC côté client

**Décision** : Le loueur fournit un prix public TTC. Le Lot 4 ne calcule ni ne déduit aucun taux de TVA.

**Ventilation du brouillon** : Le brouillon conserve et affiche : prix de location, options éventuelles, frais obligatoires éventuels, total client, devise, taxes (lorsque leur décomposition est connue).

**Amendement 22-B0** : pour les nouveaux bookings portant le snapshot
`split-13-7-v1`, `total_amount_minor` reste la base marchande historique dans
les tables internes tandis que `customer_total_amount_minor` porte le total
réellement payé par le client. Les surfaces publiques utilisent le total
client et détaillent séparément le frais de service. Les bookings legacy ne
sont pas réinterprétés.

**Règles** :

- `total_amount_minor` est **non nullable** ; pour un enregistrement legacy il
  représente le total public historique. Pour un split, le total public est
  `customer_total_amount_minor`, copié depuis le snapshot immuable.
- Aucun frais obligatoire ne peut être ajouté silencieusement après la création du brouillon.
- Les montants des lignes sont déjà des prix publics TTC.
- `tax_status` vaut `UNDETERMINED` au Lot 4 tant que le régime fiscal n'est pas configuré.
- `tax_amount_minor` et `tax_rate_bps` sont `null` lorsque `tax_status = UNDETERMINED`.
- `NOT_APPLICABLE` signifie que le régime a été déterminé comme non applicable : `tax_amount_minor = 0`.
- `APPLIED` signifie que la décomposition est connue et figée.
- La décomposition fiscale doit être résolue avant la confirmation du Lot 5.
- Aucune valeur fiscale ne doit être inventée.

**Commission** :

- `commission_amount_minor = null` signifie uniquement `UNDETERMINED` (commission non encore arbitrée).
- `commission_amount_minor = 0` signifie explicitement aucune commission.
- Une valeur positive signifie une commission connue.
- La commission est interne au calcul du versement loueur ; elle ne devient pas automatiquement un frais client.
- La réservation confirmée devra contenir une commission déterminée, y compris `0` si elle est non applicable.

**Motif** : Le client voit un prix total transparent (principe Airbnb). La fiscalité est un sujet Lot 5 qui ne doit pas être anticipé. Le total client est non nullable car il est toujours connu (prix public TTC fourni par le loueur).

**MVP** : Prix public TTC, `total_amount_minor` non nullable, `tax_status = UNDETERMINED`, champs fiscaux nullable, commission nullable.

**Reporté** : Décomposition fiscale, calcul de TVA, commission appliquée (Lot 5).

**Réserve juridique/finance** : Taxes, facturation et rôle légal d'Uttily restent OUVERT (Lot 5). La décomposition fiscale doit être résolue avant la confirmation.

---

## Décision 3 — Unité de durée : jours civils du lieu de retrait

**Décision** : La facturation utilise les **jours civils du lieu de retrait**, pas des tranches UTC glissantes de 24 heures.

**Définition produit** :

- `customer_period` est un intervalle semi-ouvert `[customer_start_at, customer_end_at)`.
- La durée doit être strictement positive.
- Une unité est facturée pour chaque date civile locale intersectée par cet intervalle.
- La date locale correspondant exactement à la borne de fin exclue n'est pas facturée.
- Minimum : une unité.
- Les instants sont stockés en UTC.
- Le calcul des dates civiles utilise le fuseau IANA du lieu.
- Un changement d'heure de 23 ou 25 heures ne change pas le nombre de jours civils.

**Exemples** (fuseau Europe/Paris) :

- Location sur une seule date (10h à 18h le 15 juin) : 1 jour.
- Franchissement de minuit (10h le 15 juin à 14h le 16 juin) : 2 jours.
- Fin exactement à minuit (10h le 15 juin à 00h00 le 16 juin) : 1 jour (borne de fin exclue).
- Changement heure d'été/hiver (passage à 3h le 31 mars) : le jour civil compte 23 heures mais reste 1 jour.
- Intervalle invalide ou nul (`start >= end`) : refusé.

**Motif** : Les jours civils correspondent à la perception du client. Les tranches UTC de 24 heures produisent des effets contre-intuitifs lors des changements d'heure. Le fuseau du lieu est déjà conservé sur `locations`.

**MVP** : Jours civils, fuseau IANA du lieu, intervalle semi-ouvert, minimum 1 jour.

**Reporté** : Paliers (demi-journée, semaine), tarification horaire.

**Alternatives écartées** : Tranche glissante de 24 heures (effets contre-intuitifs DST), journée commerciale selon horaires de retrait (complexité accrue non justifiée au MVP).

---

## Décision 4 — Devise : EUR uniquement

**Décision** : EUR uniquement au MVP. Aucune conversion.

**Règles** :

- La devise reste explicitement stockée dans le snapshot et associée à tous les montants.
- Toute incohérence de devise est refusée.

**Motif** : Le pilote cible une destination européenne. Une seule devise simplifie les calculs, l'affichage et les paiements (Stripe EUR). Le champ `defaultCurrency` reste dans le schéma pour les évolutions futures.

**MVP** : EUR uniquement, devise stockée dans le snapshot, validation de cohérence.

**Reporté** : Multi-devise, conversion à l'affichage.

---

## Décision 5 — Conditions physiques réservables

**Décision** :

- **Réservables** : `NEW`, `GOOD`, `FAIR`.
- **Non réservables** : `POOR`, `BROKEN`.

**Règles** : Le statut structurel `ACTIVE` reste indépendant de `condition`. Un exemplaire doit être simultanément : structurellement `ACTIVE`, dans une condition éligible, rattaché au lieu et au loueur concernés, sans bloc incompatible sur `blocked_period`.

**Motif** : `POOR` et `BROKEN` indiquent un état dégradé incompatible avec une location au MVP. `FAIR` reste réservable car l'équipement est fonctionnel. Le filtrage se fait dans la sélection des items réservables.

**MVP** : Filtre `condition IN ('NEW', 'GOOD', 'FAIR')` + `status = 'ACTIVE'`.

**Reporté** : Éligibilité configurable par le loueur, affichage de la condition au client.

**Alternative écartée** : `POOR` réservable (risque de litige sur la qualité au MVP).

---

## Décision 6 — Identité client : authentification obligatoire

**Décision** : Authentification obligatoire avant la création du brouillon avec hold. `customer_user_id` est non nullable. Aucun checkout invité au MVP. Le contrôle d'autorisation et l'identité sont établis côté serveur.

**Motif** : La traçabilité est complète, l'email est connu dès le départ, pas de brouillon orphelin. La friction est acceptable car le client doit de toute façon s'authentifier pour la gestion de sa réservation.

**MVP** : `customer_user_id` NOT NULL sur `BookingDraft`, authentification Clerk (ADR-006).

**Reporté** : Checkout invité, création de compte à la confirmation.

**Alternative écartée** : Brouillon invité (brouillons orphelins, complexité des requêtes nullable).

---

## Décision 7 — Hold et marges opérationnelles

**Décision** :

- Durée du hold `ACTIVE` : **10 minutes**.
- Marge de préparation : **30 minutes** avant `customer_start_at`.
- Marge de contrôle/nettoyage : **30 minutes** après `customer_end_at`.
- Ces valeurs sont portées par le lieu (`locations`).
- Les valeurs effectivement appliquées sont **figées dans le brouillon** (snapshot).
- `blocked_period` est dérivée de `customer_period` et des marges figées.
- Une modification ultérieure du lieu ne modifie pas un brouillon existant.
- La contrainte PostgreSQL `no_overlapping_blocks` reste l'autorité ultime.

**Motif** : 10 minutes suffisent pour un paiement Stripe classique. Les marges de 30 minutes couvrent la préparation et le nettoyage. Le snapshot des marges garantit que le brouillon reste cohérent même si le lieu est modifié ultérieurement.

**MVP** : Hold 10 min, marges 30 min sur `locations`, snapshot des marges dans le brouillon.

**Reporté** : Hold configurable par organisation, marges par variante.

---

## Décision 8 — Paiement tardif et PAYMENT_PROCESSING

**Décision** : Cutoff strict avec transition atomique obligatoire.

**Règles** :

- `ACTIVE → PAYMENT_PROCESSING` doit être atomique.
- Cette transition est **refusée** si `expires_at` est déjà dépassé au moment de la prise du verrou.
- Un hold `ACTIVE` expiré n'est **jamais convertible**, même si le worker ne l'a pas encore libéré.
- Seul `PAYMENT_PROCESSING` peut rester convertible après `expires_at`.
- `PAYMENT_PROCESSING` est **exclu du batch normal d'expiration**.
- Délai de traitement proposé et approuvé : **30 minutes**.
- Dépasser ce délai ne provoque **jamais** une libération automatique aveugle.
- Un `PAYMENT_PROCESSING` ancien passe par une **réconciliation dédiée** ou une **intervention manuelle**.
- Aucune requête réseau Stripe ne doit être faite pendant qu'un verrou PostgreSQL est conservé.
- Worker et webhook verrouillent la **même ressource transactionnelle**.
- Une confirmation externe reçue après libération ne réactive pas le hold et ne réalloue pas les exemplaires.
- Elle déclenche une **compensation idempotente**.
- La mécanique exacte du remboursement appartient au Lot 5 et reste soumise aux décisions paiement/juridique.

**Motif** : Le résultat doit dépendre uniquement de l'état du hold et du timestamp, pas de l'ordre d'exécution worker/webhook. Le cutoff strict est déterministe et indépendant du retard du Cron.

**MVP** : Cutoff strict, transition atomique, `PAYMENT_PROCESSING` exclu du batch normal, réconciliation dédiée, compensation idempotente.

**Reporté** : Mécanique exacte du remboursement (Lot 5).

**Réserve juridique/finance** : La compensation des paiements confirmés tardivement reste à valider (produit / paiement / juridique, décision nécessaire avant Lot 5).

---

## Décision 9 — Représentation technique des montants

**Décision d'architecture** :

- PostgreSQL : `bigint`.
- Drizzle : `bigint({ mode: "number" })`.
- TypeScript et JSON : `number`.
- `Number.isSafeInteger` obligatoire aux frontières.
- Montants non négatifs.
- Contrainte ou invariant garantissant une valeur inférieure ou égale à `Number.MAX_SAFE_INTEGER`.
- Addition et multiplication vérifiées.
- Aucune arithmétique flottante.
- Aucune conversion silencieuse depuis `bigint` JavaScript.
- Devise ISO 4217 explicite.

**Note** : PostgreSQL `bigint` ne devient pas automatiquement `bigint` JavaScript : le mode Drizzle est explicite (`mode: "number"`). La sérialisation JSON de `bigint` JavaScript lève une `TypeError` ; c'est pourquoi le mode `number` est utilisé, avec `Number.isSafeInteger` aux frontières.

**Motif** : `bigint` en base offre une marge confortable pour l'avenir. Le mode `number` de Drizzle évite la complexité de sérialisation JSON des `bigint` JavaScript. Les contrôles `Number.isSafeInteger` et les bornes garantissent la sécurité. La règle verrouillée AGENTS.md (entiers en unités mineures) est respectée.

**MVP** : `bigint` en base, `number` en TS/JSON, contrôles de sécurité.

---

## Traçabilité

- **Date de décision** : 2026-07-28.
- **Autorité** : porteur produit par délégation.
- **Statut produit** : approuvé.
- **Statut juridique/finance** : en attente pour les sujets concernés (politique d'annulation, taxes, commission, compensation).
- **Aucune autorisation d'implémentation** avant acceptation de l'ADR-009.

## Alternatives écartées (traçabilité)

- Politique d'annulation unique sans choix : rejetée car trois politiques prédéfinies couvrent mieux les besoins du pilote.
- Tranche glissante de 24 heures : rejetée car effets contre-intuitifs lors des changements d'heure.
- Journée commerciale selon horaires : rejetée car complexité non justifiée au MVP.
- `POOR` réservable : rejetée car risque de litige sur la qualité.
- Brouillon invité : rejeté car brouillons orphelins et complexité nullable.
- `integer` (int4) en base : rejeté au profit de `bigint` pour la marge future.
- Fenêtre de grâce sur l'expiration : rejetée au profit du cutoff strict déterministe.
