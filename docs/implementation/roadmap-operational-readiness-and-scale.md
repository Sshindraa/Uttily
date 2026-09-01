# Roadmap — préparation opérationnelle, universalisation et passage à l'échelle

**Statut :** document vivant de planification ; ne vaut ni ADR ni validation
Finance/Juridique/DPO
**Date de création :** 2026-09-01
**Référence de lecture :** toujours vérifier la branche, le commit et le statut
Git courants avant d'utiliser un état de livraison mentionné ici.

## 1. Objet

Cette roadmap organise le travail restant pour faire d'Uttily une plateforme
opérationnelle pour une grande diversité de loueurs professionnels, sans faire
dépendre la conception du produit d'un premier partenaire particulier.

La doctrine est :

> Construire immédiatement le cœur universel, simuler les situations
> prévisibles, configurer les différences entre catégories et utiliser les
> exploitations réelles pour améliorer — jamais pour commencer.

La cible n'est pas de couvrir avant le lancement toutes les particularités de
toutes les catégories. La cible est de disposer d'un cœur opérationnel complet,
fiable et autonome, puis d'activer les verticales et les pays par configuration
et décisions dédiées.

## 2. Autorités et frontières

Cette roadmap ne remplace pas :

- le [périmètre MVP](../product/mvp-scope.md) ;
- les [ADR](../decisions/) ;
- le [backlog livré et en cours](backlog.md) ;
- les [questions ouvertes](open-questions.md) ;
- le [plan canonique de déblocage du pilote](../operations/pilot-unblock-plan.md) ;
- l'[état canonique des frais marketplace](../operations/marketplace-fees-current-state.md).

En cas de contradiction, le commit courant, les ADR acceptés et les sources
canoniques ci-dessus priment. Une capacité listée dans cette roadmap n'est pas
considérée comme approuvée ou livrée tant que son lot, ses critères, ses tests
et, si nécessaire, son ADR ne le prouvent pas.

La roadmap de [remise à niveau et nettoyage](roadmap-remise-a-niveau-nettoyage.md)
reste l'autorité pour le ménage différentiel du dépôt. Le présent document porte
sur la trajectoire produit et opérationnelle globale.

## 3. Baseline constatée au 2026-09-01

Le socle existant couvre déjà :

- organisations, établissements, équipes et permissions ;
- catalogue, variantes et exemplaires physiques ;
- disponibilité transactionnelle et anti-surbooking PostgreSQL ;
- plans tarifaires flexibles et snapshots immuables ;
- hold, paiement Stripe TEST, confirmation et réconciliation ;
- annulations et amendements de réservation ;
- retrait, retour, rapports d'état, dommages et maintenance minimale ;
- recherche publique géographique et checkout ;
- photos R2, Photo Coach vélo et publication fail-closed ;
- documents PDF, emails, outbox et worker ;
- dashboard loueur, finances et support interne ;
- staging réel, observabilité minimale, runbooks et restore drill local ;
- architecture frontend par routes, features, shells et primitives UI stabilisée
  sur le checkout courant.

Au moment de la création de cette roadmap, `pnpm check:fast` est vert sur le
checkout courant. Cela ne remplace pas la validation finale complète. La refonte
frontend locale touche un grand nombre de fichiers et doit être commitée et
validée avant l'ouverture de nouveaux chantiers fonctionnels concurrents.

### État d'exécution de la Phase 0 au 2026-09-01

La refonte frontend du checkout courant est techniquement finalisée : les vues
d'accueil, de sélection d'organisation et de support interne sont composées
depuis leurs features et shells canoniques, les façades mortes et assets de
conception non utilisés ont été retirés, et les exports publics de `@uttily/ui`
restent compatibles. Les URLs, redirections historiques, Server Actions,
permissions, frontières Core, idempotence et isolation tenant n'ont pas été
modifiées.

Les preuves obtenues sur ce checkout sont les suivantes : migrations depuis une
base vierge avec 50 entrées Drizzle, suite Database PostgreSQL locale (24
fichiers, 816 tests passés, aucun skip), suite Core PostgreSQL complète (158
fichiers, 2 973 tests passés, aucun skip), restore drill réel local `PASS`, lint,
format, typecheck, build Web/worker, smoke du bundle worker, contrôles de
recovery et Playwright public responsive/accessibilité (16/16). Le correctif
final séquence désormais `test:full` avec `--workspace-concurrency=1` et son
garde-fou est couvert ; `pnpm check:fast` passe avec 35/35 tests de scripts.
Après rebase exact sur `origin/main` (`aa1350d`), les quatre commits propres sont
`ee382ac`, `04a9b88`, `4426da7` et `200a2f3`. L'arbre fonctionnel est strictement
identique à la sauvegarde du checkout précédent (`05ac1c3`), sans différence.
La validation CI parallèle du run
[#33498404591](https://github.com/Sshindraa/Uttily/actions/runs/33498404591)
est entièrement verte, y compris les six shards Core, Database, Build, Quality,
Verify et Browser acceptance ; ce dernier a validé les E2E authentifiés avec les
credentials Clerk TEST de la CI. La PR #40 est fusionnée ; la PR #42, issue de
la tranche photos/maintenance, a ensuite été fusionnée au commit
`eebaf08` sur `origin/main` après validation verte du run
[#33504787871](https://github.com/Sshindraa/Uttily/actions/runs/33504787871).
`pnpm test:full` n'a pas été relancé localement, conformément à la procédure de
clôture.

## 4. Niveaux de priorité

| Niveau | Sens |
| --- | --- |
| `P0` | Bloque la stabilisation ou toute ouverture commerciale LIVE. |
| `P1` | Requis pour présenter Uttily comme OS loueur autonome et opérationnel. |
| `P2` | Requis avant passage à l'échelle multi-loueurs et multi-sites. |
| `P3` | Différenciation, distribution et intelligence après fiabilité du cœur. |
| `P4` | Expansion catégories, pays et modèles structurels futurs. |

---

## 5. Phase 0 — Stabiliser le checkout courant (`P0`)

### 5.1 Refonte frontend finalisée techniquement

**Statut au 2026-09-01 :** les extractions, le nettoyage des références et la
vérification des assets sont terminés sur le checkout courant. La validation
globale de sortie reste conditionnée par le gate de la section 5.3.

- terminer l'extraction des routes vers `apps/web/src/features/` ;
- confirmer que les routes restent des surfaces d'orchestration ;
- supprimer les duplications et anciens fichiers devenus inutiles ;
- préserver les Server Actions, gardes serveur et frontières Core existantes ;
- harmoniser les shells Client, Pro et Support ;
- stabiliser les primitives et exports `@uttily/ui` ;
- vérifier les polices, licences, images et assets ajoutés ;
- réaligner les documents qui décrivent encore un état antérieur.

### 5.2 Validation finale

- lint et formatage ;
- tests rapides et typecheck ;
- tests complets des workspaces ;
- suites PostgreSQL ciblées puis complètes ;
- migrations depuis une base vierge ;
- build Web et worker ;
- smoke test du bundle worker ;
- parcours navigateur public et authentifié ;
- validation mobile, tablette et desktop ;
- accessibilité clavier, focus, contraste et lecteur d'écran ;
- validation FR/EN ;
- restore drill et contrôles de scripts.

### 5.3 Gate de sortie

**Résultat au 2026-09-01 : `COMPLET`.** Les preuves PostgreSQL Database, Core
complet, migrations vierges, restore drill réel, validation CI parallèle et E2E
authentifié Browser sont disponibles. Le conflit de la PR #40 est résolu et la
PR est mergeable ; aucune tâche de Phase 1 n'est ouverte par cette clôture.

- arbre Git maîtrisé et commits cohérents ;
- CI complète verte ;
- aucun statut documentaire ne déclare livré un changement non présent dans le
  commit ;
- aucune régression fonctionnelle, visuelle ou d'autorisation connue.

---

## 6. Phase 1 — Déblocage commercial et LIVE (`P0`)

Le détail des blockers humains reste exclusivement dans le
[plan 21-P0](../operations/pilot-unblock-plan.md). Les chantiers ci-dessous ne
doivent pas recopier ni réinterpréter ses 31 décisions.

### 6.1 Finance et paiements

- clôturer `FIN-001` à `FIN-008` selon leur périmètre ;
- valider le split `13/7`, sa base, sa date d'effet et son traitement fiscal ;
- valider settlement, frais Stripe, soldes négatifs, chargebacks et litiges ;
- faire passer l'ADR-030 à `Accepted` uniquement après sign-off ;
- implémenter ensuite le remboursement split composant par composant ;
- persister remboursement client, reprise loueur, restitution Uttily et frais
  provider non récupérables ;
- tester plusieurs amendements et plusieurs origines de paiement ;
- conserver le fail-closed tant que la preuve provider et la réconciliation ne
  sont pas validées.

### 6.2 Juridique et contrats

- publier et versionner CGU/CGV client ;
- publier et versionner les conditions Pro ;
- valider l'émetteur des documents, les mentions et leur numérotation ;
- fixer les politiques d'annulation horaires et journalières ;
- décider l'annulation après `READY_FOR_PICKUP` ;
- définir `CANCELLED`, `REFUNDED`, no-show, retard et restitution tardive ;
- cadrer dommages, preuve d'état, contestation et responsabilité ;
- décider signature électronique ou acceptation simple ;
- décider la stratégie de caution par catégorie ou `NO_DEPOSIT` explicite ;
- définir substitution, upgrade et future garantie de disponibilité.

### 6.3 Privacy et données

- publier la politique de confidentialité ;
- documenter finalités, bases légales et sous-traitants ;
- fixer les rétentions par catégorie de données ;
- décider suppression, anonymisation et webhook Clerk `user.deleted` ;
- construire, après décision, accès, rectification, opposition et portabilité ;
- valider analytics production ;
- décider la modération et les droits sur les contenus et photos ;
- encadrer les profils de famille et les données de mineurs avant tout Outdoor
  Passport familial.

### 6.4 Infrastructure LIVE et recovery

- provisionner Vercel, Neon, Clerk, Stripe, R2 et Resend LIVE ;
- configurer domaines, expéditeurs, webhooks, allow-list et rate-limit ;
- déployer worker et scheduler de production ;
- définir alertes techniques et métier ;
- exécuter une restauration Neon isolée réelle ;
- mesurer RPO/RTO ;
- tester le rollback Vercel ;
- nommer responsables et contacts d'escalade ;
- tester la rotation des secrets ;
- exécuter un smoke test LIVE autorisé avec plan de rollback.

### 6.5 Gate de sortie

- aucun blocker 21-P0 requis pour le type de lancement choisi ;
- `pnpm readiness:live` vert dans l'environnement autorisé ;
- smoke test et récupération provider prouvés ;
- Go explicite Produit, Finance, Juridique et DPO.

---

## 7. Phase 2 — Uttily OS universel (`P1`)

### 7.1 Expérience générique « Mes équipements »

- faire de la fiche équipement unifiée la surface générique du loueur ;
- conserver le vélo comme premier module de catégorie approfondi ;
- séparer champs universels et extensions de catégorie ;
- retirer les hypothèses vélo des moteurs et parcours génériques ;
- configurer libellés, caractéristiques, photos, sécurité et maintenance par
  catégorie ;
- ne jamais remplacer le modèle relationnel Produit/Variante/Exemplaire par une
  abstraction UX non transactionnelle.

**Tranches techniques livrées le 2026-09-01 :** un registre frontend de
présentation par catégorie est en place (ADR-034), avec libellés singulier /
pluriel, caractéristiques affichables, sections spécifiques et fallback
générique. Les surfaces liste et fiche existantes l'utilisent pour la catégorie
`equipment` et les catégories inconnues ; le vélo conserve ses slots photo,
son Photo Coach et sa sécurité. Les surfaces photos et maintenance utilisent
désormais le même registre : gestionnaire photo neutre hors vélo et libellés
adaptés dans la flotte, l'ouverture, la liste, le détail et la remise en
service. Les read models flotte et maintenance exposent `categorySlug`, sans
migration, changement d'URL ou déplacement des règles Core.
Le périmètre ne couvre pas encore l'onboarding autonome, les opérations
groupées, ni de nouvelles règles métier spécifiques à une catégorie.

**Cadrage livré le 2026-09-01 :** ADR-035 et le registre Core ferment le
périmètre commercial aux quatre univers Cycle, Kayak/canoë/pagaie, Surf/glisse
nautique et Neige/glisse. `bike`, `kayak`, `canoe`, `paddleboard`, `surf`, `ski` et `snowboard` sont `ACTIVE`,
`equipment` reste un fallback interne et
les valeurs inconnues sont `UNSUPPORTED`. Aucune catégorie camping, outdoor
technique, sport généraliste, outillage, jardin, événementiel, audiovisuel ou
construction n'est activée. La PR #43 est fusionnée dans `b8a7a2e` après une CI complète
verte, y compris Browser acceptance avec les credentials Clerk TEST.

**Activation kayak livrée le 2026-09-01 :** la famille `kayak` est désormais
`ACTIVE`. La migration 0051 ajoute sa catégorie canonique sans conversion des
produits `equipment`; la fixture `kayak-dev` utilise cette catégorie. Le kayak
réutilise le parcours générique complet et affiche `capacity`, `construction`
et `practice` seulement lorsqu'ils existent, sans Photo Coach ni règle vélo.
Commit `2570a81`, PR #44 et CI complète verte, Browser acceptance compris.
Les tests d'intégration PostgreSQL locaux ont été délégués à cette CI, la base
locale étant indisponible pendant la validation.

**Activation surf livrée le 2026-09-01 :** la famille `surf` passe à
`ACTIVE` sans migration, car sa catégorie canonique existait déjà dans le seed.
Le socle couvre `classic`, `longboard`, `softboard`, `bodyboard` et
`skimboard` comme sous-types descriptifs du même slug `surf`. Les surfaces
loueur et publiques réutilisent le parcours générique Produit → Variante →
Exemplaire, les photos neutres, le tarif, la disponibilité, la publication,
la recherche, le hold, le paiement TEST et la confirmation. Aucun champ
dimensions/volume/niveau, aucune règle windsurf/wingfoil/kitesurf/foil et
aucun accessoire publiable seul n'est ajouté. Commit `cbcebc9`, PR #45 et CI
complète verte, Browser acceptance avec credentials Clerk TEST compris. Les
tests PostgreSQL exhaustifs restent exécutés par la CI parallèle.

**Hardening surf livré le 2026-09-01 :** l'audit des surfaces surf a détecté
que le wizard historique de création et d'édition affichait encore par défaut
le Photo Coach et les trois slots vélo. La correction minimale transmet
`categorySlug`, branche ce wizard sur le registre et fournit un upload neutre
pour `surf`, `equipment` et les catégories inconnues. Les listes, fiches,
recherche, maintenance, publication et invariants tenant restent inchangés ;
aucune migration, règle métier, nouvelle catégorie ou URL n'est ajoutée.
Tests ciblés Web/Core et typecheck Web verts ; les intégrations PostgreSQL
ciblées restent déléguées à la CI lorsqu'elles ne sont pas configurées en
local.

**Activation ski livrée le 2026-09-01 :** la famille `ski` est désormais
`ACTIVE` avec les seuls sous-types descriptifs `alpine`, `touring` et
`cross-country`, sans nouveau slug, champ spécialisé ou migration. Les parcours
loueur et publics réutilisent Produit → Variante → Exemplaire, la tarification,
la disponibilité, les photos neutres, la publication, la recherche, le hold,
le paiement TEST et la confirmation. Les surfaces internes et publiques
présentent `ski` et filtrent l'ancien libellé `Ski & Snowboard`; aucune règle
Photo Coach, slot ou sécurité vélo n'est appliquée. Snowboard, télémark,
raquettes, luges, snowscoot et packs avalanche restent inactifs.

**Hardening ski livré le 2026-09-01 :** l'audit a corrigé une régression de
présentation dans la création et l'édition : les sélecteurs affichaient encore
le nom historique `Ski & Snowboard` et la fiche répétait le libellé `ski`. Les
sélecteurs utilisent désormais `categorySlug` et le registre, tandis que le
fallback `equipment`, les sous-types absents ou inconnus, les photos neutres,
la maintenance, les surfaces publiques et l'isolation tenant restent
inchangés. Aucun schéma, champ, règle métier, URL ou nouvelle catégorie n'est
ajouté ; les familles neige non activées restent inchangées.

**Activation snowboard livrée le 2026-09-01 :** la famille `snowboard` est
`ACTIVE` sous un seul slug, sans sous-type, champ ou règle spécialisée ajoutés.
La migration 0052 ajoute sa catégorie canonique sans convertir les produits
historiques `equipment`. Les parcours loueur et publics réutilisent les
invariants génériques Produit → Variante → Exemplaire, le tarif, la
disponibilité, les photos neutres, la publication, la recherche, le hold, le
paiement TEST et la confirmation. Aucun Photo Coach, slot photo vélo, règle ski,
pack ou moteur de supplément n'est activé.

**Activation canoë livrée le 2026-09-01 :** la famille `canoe` est désormais
`ACTIVE` sous un seul slug. La migration 0053 ajoute sa catégorie canonique
sans convertir les produits historiques `equipment`; le seed local conserve
`kayak-dev` sur `kayak` et prépare la catégorie canoë. Les parcours loueur et
public réutilisent les invariants génériques Produit → Variante → Exemplaire,
le tarif, la disponibilité, les photos neutres, la publication, la recherche,
le hold, le paiement TEST et la confirmation. Aucun sous-type, champ, Photo
Coach, slot vélo, règle kayak, pack ou moteur de supplément n'est ajouté.

**Activation paddleboard livrée le 2026-09-01 :** la famille interne
`paddleboard` est `ACTIVE` sous un seul slug canonique. L'interface affiche
« Paddle » en français et « Stand-up paddle » en anglais ; les options
`single`/`tandem` et `rigid`/`inflatable` sont portées par les attributs de
variante existants, sans dimension obligatoire. La migration 0054 est
idempotente, le slug historique `paddle` et les produits `equipment` ne sont
pas convertis, et le seed local n'ajoute aucun produit publié. Les parcours
loueur/public réutilisent les invariants génériques, les trois photos valides,
la recherche, le hold, le paiement TEST et la réservation, sans Photo Coach,
slot vélo, règle kayak/canoë ou moteur de packs. Le pédalo reste inactif.

**Taxonomy enforcement livré le 2026-09-01 :** le registre fermé serveur est
désormais l'autorité commerciale des familles `bike`, `kayak`, `canoe`,
`paddleboard`, `surf`, `ski` et `snowboard`. Les mutations de création,
changement de catégorie, publication et restauration refusent `equipment`,
l'ancien `paddle`, les catégories personnalisées, inconnues, inactives ou
seulement approuvées. Les sélecteurs loueur, les filtres et les read models
publics n'exposent que les familles commerciales actives ; les produits
historiques restent lisibles sans conversion ni suppression et ne peuvent pas
être publiés ou restaurés. Aucun schéma, URL, invariant de prix,
disponibilité, tenant, maintenance, réservation ou paiement n'est modifié.

### 7.2 Onboarding autonome

- organisation, identité légale et Stripe Connect ;
- établissements, coordonnées, horaires et exceptions ;
- équipe et rôles ;
- premier équipement, tarif, stock et photos ;
- publication et réservation de test ;
- checklist serveur expliquant chaque blocage ;
- parcours utilisable sans développeur.

Prévoir plusieurs chemins d'entrée :

- création guidée pour petite flotte ;
- duplication d'équipements similaires ;
- ajout en série d'exemplaires ;
- opérations groupées ;
- import structuré pour grande flotte ;
- connecteur certifié pour un logiciel existant.

### 7.3 Catalogue et flotte

- duplication contrôlée de produit, variante et paramètres ;
- création de plusieurs exemplaires avec références déterministes ;
- numéros de série et identifiants fabricant ;
- changements groupés de statut et d'établissement ;
- transferts multi-sites ;
- inventaire physique et écarts ;
- états ACTIVE, RETIRED, LOST et conditions physiques ;
- blocages manuels et récurrents ;
- calendrier par exemplaire ;
- export catalogue et flotte ;
- import avec dry-run, mapping, erreurs et rejeu idempotent.

Le CSV reste un accélérateur optionnel, pas une source de vérité concurrente.

### 7.4 Tarification et politiques

- UI complète HOURLY, FIXED_DURATION et DAILY ;
- aperçu avant activation ;
- versionnement visible et comparaison avant/après ;
- plans locaux par établissement ;
- réductions multi-jours, fenêtres et exceptions ;
- frais obligatoires ;
- simulation prix client, frais et net loueur ;
- politiques d'annulation versionnées ;
- aucune modification destructive d'un snapshot confirmé.

### 7.5 Réservations de tous les canaux

- création dashboard pour appel, comptoir ou demande manuelle ;
- blocage d'une réservation prise hors Uttily ;
- origine et canal d'acquisition ;
- paiement hors plateforme seulement si autorisé et audité ;
- notes opérationnelles ;
- recherche client ;
- renouvellement ou duplication contrôlée ;
- vue consolidée de toutes les réservations affectant le stock.

### 7.6 Opérations quotidiennes

- file de préparation ;
- départs, retours, locations actives et retards ;
- no-show ;
- recherche rapide par réservation, client ou équipement ;
- substitution d'un exemplaire indisponible ;
- upgrade, prolongation et amendement ;
- checklist de préparation ;
- rapports d'état avec photos selon politique ;
- signature ou acceptation selon décision juridique ;
- dommage, maintenance immédiate et restitution partielle ;
- clôture opérationnelle et financière ;
- historique compréhensible et audité.

### 7.7 Maintenance et cycle de vie

- diagnostic, priorité, responsable et tâches ;
- coûts, prestataire et pièces ;
- photos avant/après ;
- date estimée de retour ;
- protection automatique de l'indisponibilité ;
- remise en service validée ;
- historique par exemplaire ;
- compteurs d'usage pertinents par catégorie ;
- retrait, revente, transfert ou reconditionnement.

### 7.8 Finances loueur

- GMV, base, frais, net et remboursements ;
- virements et anomalies ;
- rapprochement par réservation ;
- export CSV ;
- vues par période, établissement, produit et exemplaire ;
- ne jamais présenter un net de location comme un payout Stripe confirmé.

### 7.9 Support et administration

- résolution atomique des emails `REQUIRES_MANUAL_REVIEW` ;
- remboursement échoué et règlement hors plateforme audité ;
- réconciliation paiement et compensation ;
- activation pays, destinations et catégories ;
- administration de la taxonomie ;
- modération contenus/photos ;
- audit filtrable et export de preuve ;
- actions d'urgence et kill switches protégés ;
- aucune mutation financière directe non auditée.

### 7.10 Simulations obligatoires

Maintenir trois organisations de référence :

1. petite flotte, 20 exemplaires ;
2. loueur saisonnier, 200 exemplaires ;
3. multi-sites, plusieurs centaines d'exemplaires.

Simuler concurrence, affluence, casse avant retrait, no-show, retard, panne
provider, paiement ambigu, transfert, réservation externe, maintenance,
remboursement, erreur employé et tentative cross-tenant.

### 7.11 Gate de sortie

Un loueur doit pouvoir configurer et exploiter son activité sans intervention
d'un développeur. Les trois organisations de référence doivent accomplir les
parcours nominaux et les principales exceptions avec stock et finances cohérents.

---

## 8. Phase 3 — Marketplace client spécialisée (`P1/P2`)

### 8.1 Recherche et contenu

- finaliser les droits d'ingestion géographique ;
- calibrer les rayons et alternatives ;
- pages SEO destination/catégorie ;
- filtres de caractéristiques ;
- tri prix, distance et pertinence ;
- carte performante avec fallback liste ;
- contenu FR/EN et politique de traduction loueur ;
- performance et accessibilité à volume réaliste.

### 8.2 Groupes, capacités, accessoires et packs

Créer un ADR avant développement pour définir :

- capacité par variante ;
- adultes/enfants, poids et contraintes de sécurité ;
- accessoires inclus, obligatoires ou optionnels ;
- stock d'accessoires ;
- combinaisons autorisées ;
- prix et disponibilité de la configuration complète.

Puis livrer recherche de groupe, composition, allocation atomique, prix total et
alternatives explicites.

### 8.3 Compte client et réservation rapide

- participants et profils réutilisables ;
- préférences spécifiques par catégorie ;
- historique ;
- consentement, modification et suppression ;
- préremplissage ;
- wallets Stripe sans stockage carte Uttily ;
- mesurer le temps réel recherche → paiement ;
- réévaluer par ADR l'authentification obligatoire si elle bloque l'objectif ;
- récupération d'un checkout interrompu ;
- rappels avant retrait ;
- annulation et modification autonomes.

### 8.4 Confiance

- identité professionnelle factuelle et révocable ;
- photos et disponibilité réelles ;
- horaires, politiques et prix all-in visibles ;
- avis uniquement après réservation réelle, avec modération ;
- promesse « équipement garanti » uniquement après SLA, substitution, upgrade,
  compensation et support définis.

### 8.5 Gate de sortie

- temps de réservation mesuré ;
- parité recherche/checkout prouvée ;
- prix total et règles compris ;
- aucun élargissement silencieux ;
- parcours accessible et mobile sur données réalistes.

---

## 9. Phase 4 — Portabilité, intégrations et multicanal (`P2`)

### 9.1 Fondation d'intégration

- contrats versionnés ;
- identités stables et provenance ;
- idempotence et synchronisation incrémentale ;
- résolution des conflits ;
- journal de synchronisation ;
- reprise, métriques et alertes ;
- isolation tenant ;
- mode lecture seule ou bidirectionnel explicite ;
- PostgreSQL reste l'autorité finale de réservation.

### 9.2 Imports et connecteurs

- import CSV assisté ;
- prioriser Cilea, Ginkoia, Skilou, Wintersteiger et connecteurs vélo uniquement selon
  accès API et demande de marché prouvés ;
- environnement de test par connecteur ;
- matrice des données supportées ;
- politique de conflit et déconnexion ;
- certification de non-surbooking.

### 9.3 Canaux

- widget site loueur ;
- liens attribués ;
- marque blanche ;
- partenaires hôtels, campings, conciergeries et offices ;
- attribution de source ;
- reporting partenaire ;
- règles de frais par canal après ADR économique dédié ;
- partage de données et consentement contrôlés.

### 9.4 Gate de sortie

Chaque connecteur et canal dispose d'un contrat, d'une preuve de reprise, d'une
observabilité, d'une procédure de déconnexion et d'un test de concurrence stock.

---

## 10. Phase 5 — Mesure et Rental Intelligence (`P2/P3`)

### 10.1 Analytics après validation privacy

- recherches, résultats, checkout et confirmations ;
- abandons, annulations et remboursements ;
- canaux ;
- activation et rétention loueur ;
- incidents et qualité opérationnelle.

### 10.2 Performance loueur

- utilisation et revenu par exemplaire ;
- revenu par jour disponible ;
- durée moyenne ;
- périodes sous-utilisées ;
- temps de préparation, retrait et retour ;
- dommages, maintenance et indisponibilité ;
- rotation par établissement et catégorie.

### 10.3 Intelligence explicable

- prévision de demande ;
- sous-capacité et surstock ;
- transfert entre sites ;
- entretien, retrait ou revente ;
- suggestions de prix et promotions ;
- explication, version, données d'entrée et confiance ;
- validation humaine obligatoire ;
- mesure de la valeur produite et possibilité d'override.

### 10.4 Equipment Graph et recommandation

- caractéristiques, usages, niveaux et compatibilités ;
- accessoires requis et incompatibilités ;
- règles de sécurité sourcées ;
- équivalences et alternatives ;
- recommandation explicable combinant fit et disponibilité ;
- aucune décision de sécurité, prix ou facturation déléguée à un modèle seul.

---

## 11. Phase 6 — Retrait express et passeport numérique (`P3`)

### 11.1 QR Express Pickup

- pré-check-in ;
- informations complétées avant arrivée ;
- contrat, paiement et caution prêts ;
- équipement préparé et localisé ;
- QR signé, limité dans le temps et non réutilisable abusivement ;
- scan par acteur autorisé ;
- preuve de remise sans contourner l'état des lieux.

### 11.2 Mesure

- arrivée, début de prise en charge et remise ;
- temps total et étapes bloquantes ;
- comparaison avant/après ;
- promesse « deux minutes » uniquement après mesure reproductible.

### 11.3 Digital Equipment Passport

- identité durable, fabricant, modèle et série ;
- locations, mouvements, entretiens et dommages ;
- réparations, pièces et contrôles ;
- photos de référence et statut ;
- QR/NFC et droits par rôle ;
- distinction faits vérifiés, déclarations et inférences.

---

## 12. Phase 7 — Densification et distribution (`P3`)

### 12.1 Destination par destination

- seuil de loueurs, équipements et catégories ;
- couverture de disponibilité ;
- qualité de contenu ;
- taux de recherches avec résultat ;
- capacité de support ;
- plan SEO et partenaires ;
- critères d'ouverture, maintien et suspension.

### 12.2 Réseau partenaire

- hôtels, campings, conciergeries, écoles et offices ;
- stations, mobilité, voyage et apporteurs d'affaires ;
- attribution, commission, consentement et support.

### 12.3 Agent-ready Commerce

- recherche et devis structurés ;
- disponibilité, hold et paiement autorisés ;
- approbation humaine ;
- annulation et événements de suivi ;
- permissions, rate-limit, consentement et audit.

---

## 13. Phase 8 — Catégories et pays (`P4`)

### 13.1 Kit d'activation d'une catégorie

Chaque catégorie définit avant activation :

- attributs et variantes ;
- capacité et accessoires ;
- tarification ;
- photos ;
- entretien et sécurité ;
- caution ;
- mensurations client ;
- substitution ;
- documents ;
- critères de publication.

Ordre d'activation encadré par ADR-035 : `bike`, `kayak`, `canoe`, `paddleboard`,
`surf`, `ski` et `snowboard` actifs ; les autres familles pagaie, les familles neige
non activées et les familles hors taxonomie fermée sont exclues.

### 13.2 Kit d'activation pays

- devise et fiscalité ;
- Stripe Connect et moyens de paiement ;
- identité légale, contrats, annulations et caution ;
- langue, support et données ;
- géocodage ;
- obligations propres aux catégories.

### 13.3 Extensions exigeant un ADR

- conversion de devises ;
- livraison, casiers et points relais ;
- assurance et sinistres ;
- panier multi-loueurs ;
- location entre particuliers ;
- abonnement et fidélité.

---

## 14. Ordre d'exécution consolidé

### Maintenant

1. Stabiliser et merger le chantier frontend courant.
2. Exécuter la validation finale complète.
3. Clôturer en parallèle les décisions 21-P0.
4. Préparer les environnements et exercices LIVE.

### Avant ouverture commerciale générale

1. Aucun blocker finance/juridique/privacy applicable.
2. Production, rollback et restauration prouvés.
3. Onboarding autonome et surface générique « Mes équipements ».
4. Réservation marketplace, comptoir et externe cohérentes avec le stock.
5. No-show, retard, substitution, maintenance et refund traités.
6. Support capable de résoudre les incidents sans SQL manuel partiel.
7. Export et portabilité définis.
8. Parcours mobile et simulations multi-volumes validés.

### Avant passage à l'échelle

1. Opérations groupées et imports robustes.
2. Multi-sites complet.
3. Observabilité et SLOs.
4. Analytics produit et loueur autorisées.
5. Fondation d'intégration certifiée.

### Différenciation

1. Profils client progressifs.
2. Groupes, packs et recommandations.
3. QR Express Pickup.
4. Distribution partenaire.
5. Rental Intelligence.
6. Equipment Graph et passeport numérique.

## 15. Doctrine de sélection d'un chantier

Un chantier est prioritaire s'il :

1. rend Uttily exploitable par davantage de loueurs ;
2. réduit le travail par réservation ;
3. améliore la fiabilité de disponibilité ;
4. augmente les réservations ou le revenu du parc ;
5. renforce confiance, sécurité, conformité ou résilience ;
6. évite une impasse structurelle démontrée.

Une fonctionnalité ne doit pas être avancée seulement parce qu'elle est
spectaculaire. Elle doit disposer d'un propriétaire, d'un problème précis, de
critères d'acceptation, d'une mesure de valeur et des décisions préalables
nécessaires.
