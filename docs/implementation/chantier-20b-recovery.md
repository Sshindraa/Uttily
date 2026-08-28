# Chantier 20-B — Recovery & Disaster Readiness (FAST)

## Périmètre et garde-fous

Ce chantier couvre uniquement la récupération PostgreSQL/Neon, les migrations,
les sauvegardes/restaurations, la récupération Stripe, les webhooks et la
réconciliation, les workers/crons, le rollback Vercel et la rotation des
secrets. Il n'introduit ni nouveau service, ni nouvelle source de vérité.

Le drill exécutable est volontairement local : il refuse toute URL dont
l'hôte n'est pas `localhost`, `127.0.0.1` ou `::1`, exige
`UTTILY_RECOVERY_DRILL=1`, refuse `NODE_ENV=production`, et ne crée/supprime
que des bases dont le nom généré commence par `uttily_recovery_source_` ou
`uttily_recovery_restored_`. Aucun accès Neon, Vercel, Stripe LIVE ou base
réelle n'a été nécessaire pour le drill.

## Statut de preuve

| Élément | Statut | Nature de la preuve / limite |
| --- | --- | --- |
| Fixture relationnelle org → réservation → paiement → inventaire → outbox | `PROVENUE_PAR_DRILL` | Insérée, dumpée, mutée, restaurée puis vérifiée sur PostgreSQL local éphémère. |
| Format de sauvegarde `pg_dump --format=custom` et restauration `pg_restore` | `PROVENUE_PAR_DRILL` | Exécuté par `pnpm recovery:restore-drill`. |
| Migrations Drizzle rejouables sur une base vierge | `PROVENUE_PAR_DRILL` | Le drill migre sa base source vierge avant d'insérer la fixture. |
| Restauration Neon réelle, PITR, rétention et snapshots | `DEPENDANCE_PROVIDER` / `A_CONFIRMER` | La procédure opérateur Neon reste à exécuter avec les droits et le projet concernés. |
| Rollback d'un déploiement Vercel | `DEPENDANCE_PROVIDER` / `A_CONFIRMER` | Le runbook décrit l'action sûre, sans prétendre l'avoir exécutée. |
| RPO/RTO de staging ou production | `A_CONFIRMER` | Aucun SLA ni temps fournisseur n'est inventé par ce chantier. |

Le résultat détaillé du dernier exercice est consigné dans
[`chantier-20b-restore-drill-report.md`](chantier-20b-restore-drill-report.md).

Le drill prouve le mécanisme de récupération logique local, pas une garantie de
disponibilité ni un RPO/RTO commercial. Les valeurs opérationnelles doivent être
mesurées lors d'un exercice autorisé sur l'environnement concerné.

## B1 — Restore drill

### Commande

Depuis le worktree du chantier, avec une base PostgreSQL/PostGIS locale
accessible et les dépendances installées :

```bash
UTTILY_RECOVERY_DRILL=1 NODE_ENV=test pnpm recovery:restore-drill
```

La valeur de `DATABASE_URL` peut être fournie, mais elle doit rester locale.
Sans valeur, le script utilise `postgresql://uttily:uttily@127.0.0.1:5432/uttily`.

### Séquence reproduite

1. Vérification des garde-fous et de la présence de `pg_dump`, `pg_restore` et
   `psql`.
2. Création de deux bases locales éphémères nommées par le script.
3. Application des migrations sur la base source.
4. Insertion d'une fixture représentative : organisation professionnelle,
   utilisateur, lieu, produit/variante, exemplaire, draft, hold/allocation,
   paiement Stripe TEST, tentative de paiement, webhook, réservation, blocage
   BOOKING, lien d'exemplaire, événement outbox et quatre effets.
5. Dump custom avant une mutation volontaire (suppression des effets/outbox et
   du lien de réservation, puis états financiers/opérationnels incohérents).
6. Restauration dans la seconde base vierge.
7. Vérification des relations et états attendus : réservation `CONFIRMED`,
   paiement `SUCCEEDED`, blocage actif, exemplaire relié, variante reliée,
   outbox `PENDING` et quatre effets présents.
8. Suppression contrôlée des deux bases générées et du fichier temporaire, même
   en cas d'échec.

Un résultat JSON `status: PASS` est la seule preuve positive du drill. Un échec
doit être conservé comme échec d'exercice, sans relancer sur un environnement
réel pour le masquer.

### Équivalent Neon à faire par un opérateur autorisé

Le provider doit confirmer la méthode supportée pour exporter ou restaurer un
checkpoint vers une base isolée. L'opérateur doit alors : capturer le
checkpoint, restaurer dans une cible non utilisée par l'application, exécuter
les vérifications relationnelles de la fixture adaptée à l'environnement, puis
consigner durée, point de récupération et limites. Cette étape est une
`DEPENDANCE_PROVIDER`, pas une preuve fournie par ce commit.

## B2 — Migrations et rollback

### Procédure exécutable courte

1. **Pré-déploiement** : identifier le SHA livré, vérifier le diff de migration,
   lire la classification ci-dessous, vérifier la compatibilité du code avant et
   après migration, et exécuter les tests ciblés database/core/web concernés.
2. **Checkpoint** : obtenir un backup ou snapshot validé par l'opérateur de la
   plateforme avant toute migration `BACKUP_REQUIRED`. Noter l'heure UTC, la
   cible, le SHA et le résultat sans mettre de secret dans les logs.
3. **Migration** : exécuter uniquement avec `DATABASE_DIRECT_URL` de
   l'environnement autorisé :
   `pnpm --filter @uttily/database db:migrate`.
4. **Vérification** : vérifier que la migration attendue est enregistrée par
   Drizzle, lire `/internal/health`, vérifier les erreurs de connexion,
   l'outbox, les leases expirées et les signaux de réconciliation. Pour une
   migration de paiement/réservation, effectuer en plus une lecture ciblée des
   relations concernées.
5. **Rollback applicatif** : si le code est fautif, promouvoir dans Vercel le
   dernier déploiement compatible avec le schéma courant. Une migration déjà
   appliquée n'est pas annulée par un simple rollback du binaire.
6. **Migration irréversible** : arrêter le déploiement, conserver le checkpoint,
   préparer une migration forward corrective et faire valider le plan par le
   propriétaire technique. Ne pas réécrire, renommer ou supprimer l'historique
   Drizzle.

### Registre V1 des migrations réellement risquées

Ce registre ne classe que les migrations dont le SQL modifie un contrat,
effectue un backfill, transforme un enum ou ajoute des contraintes/triggers à
des données déjà existantes. Les autres migrations ne reçoivent pas ici une
promesse de rollback automatique : elles restent soumises aux tests et au
checkpoint de l'environnement.

| Catégorie | Migrations | Risque concret | Traitement |
| --- | --- | --- | --- |
| `SAFE` | Aucune dans ce registre | Aucun changement critique n'est déclaré automatiquement sûr pour un déploiement distant. | Tests ciblés + vérification post-déploiement. |
| `BACKUP_REQUIRED` | `0025`, `0032` | Backfill `payments.environment` puis `NOT NULL`/CHECK ; backfill devise de lieu, changement de contrainte devise et activation de données de pricing. | Snapshot/backup vérifié avant migration ; lecture des comptes/paiements/plans après migration. |
| `EXPAND_CONTRACT_REQUIRED` | `0029`, `0031`, `0033`, `0043`, `0045`, `0048` | Remplacement d'enums et contraintes email ; nouveaux contrats de recherche publique ; snapshots et triggers de prix ; nouvelles valeurs d'enum ; durcissement des leases notification ; nouvelle valeur d'enum invitation. | Déployer une version compatible avant/après ; ne pas retirer l'ancien contrat tant que les consommateurs ne sont pas migrés. |
| `NON_REVERSIBLE` | Aucune perte de données confirmée dans le SQL V1 audité | Certaines opérations structurelles ne disposent pas d'un rollback Drizzle livré, sans pour autant supprimer ici une donnée métier confirmée. | Toute anomalie se corrige forward, depuis le checkpoint ; validation humaine obligatoire. |

Les numéros correspondent aux fichiers versionnés dans
`packages/database/drizzle/`. Ce tableau ne modifie pas leur historique.

## B3 — Runbooks

Les huit runbooks séparés sont dans [`docs/runbooks/`](../runbooks/). Ils
réutilisent uniquement les mécanismes existants : `/internal/health`, Support
payments, `reconcilePaymentSupport`, les routes cron authentifiées, la
réconciliation provider et le worker outbox avec lease/fencing.

| Incident | Runbook |
| --- | --- |
| Webhook Stripe en panne | [`20b-stripe-webhook-outage.md`](../runbooks/20b-stripe-webhook-outage.md) |
| Paiement réussi, réservation non confirmée | [`20b-payment-succeeded-booking-not-confirmed.md`](../runbooks/20b-payment-succeeded-booking-not-confirmed.md) |
| Remboursement provider ambigu | [`20b-refund-provider-ambiguous.md`](../runbooks/20b-refund-provider-ambiguous.md) |
| Workers/crons arrêtés | [`20b-workers-crons-stopped.md`](../runbooks/20b-workers-crons-stopped.md) |
| Base indisponible | [`20b-database-unavailable.md`](../runbooks/20b-database-unavailable.md) |
| Déploiement Vercel cassé | [`20b-vercel-deployment-broken.md`](../runbooks/20b-vercel-deployment-broken.md) |
| Secret compromis | [`20b-secret-compromised.md`](../runbooks/20b-secret-compromised.md) |
| Sur-réservation suspectée | [`20b-suspected-overbooking.md`](../runbooks/20b-suspected-overbooking.md) |

## B4 — Ce qui est prouvé et ce qui reste à confirmer

### Cible interne (`TARGET_INTERNAL`)

- Un backup/checkpoint précède chaque migration classée à risque.
- Une restauration est faite dans une cible isolée, puis vérifiée par relations
  métier et non par le seul code retour de l'outil.
- Une anomalie de paiement passe par les écrans Support et la réconciliation
  idempotente ; aucun statut financier n'est édité directement.
- Un événement outbox est repris par lease/reclaim/fencing ; les effets gardent
  leurs clés d'idempotence.
- Un rollback applicatif ne transforme pas une migration déjà appliquée en
  rollback SQL implicite.

### Preuve apportée par ce drill (`PROVENUE_PAR_DRILL`)

- La séquence locale vierge → migrations → fixture → dump → mutation → restore
  → vérifications est automatisable.
- Les relations réservation/paiement/blocage/inventaire/outbox sont retrouvées
  après restauration.
- Les garde-fous empêchent d'utiliser une URL distante ou un environnement de
  production.

### Dépendances provider (`DEPENDANCE_PROVIDER`)

- Neon : méthode exacte de snapshot/PITR, restauration dans une cible isolée,
  rétention et droits de l'équipe.
- Vercel : accès à la promotion du dernier déploiement compatible et temps de
  propagation observé.
- Stripe : disponibilité de la recherche/relecture des événements, délai de
  conservation et comportement des remboursements ambigus.
- Fournisseur de secrets/Clerk/R2/Resend : propagation et révocation effective.

### À confirmer (`A_CONFIRMER`)

- RPO et RTO mesurés par environnement, avec un exercice autorisé.
- Fréquence des checkpoints, rétention, propriétaire et procédure d'accès.
- Contact d'escalade 24/7 et autorité pour mettre en pause paiements, webhooks
  ou fulfillment.
- Compatibilité de chaque futur rollback Vercel avec les migrations déjà
  appliquées.

## B5 — Rotation des secrets

La rotation ci-dessous est une procédure opérateur. Aucune rotation LIVE n'a
été exécutée par ce chantier. Les clés `NEXT_PUBLIC_*` sont publiques et ne
doivent pas être traitées comme des secrets ; elles nécessitent un nouveau
build lorsqu'elles changent.

| Secret présent | Introduire le nouveau | Coexistence / retrait | Impact et rollback |
| --- | --- | --- | --- |
| `STRIPE_SECRET_KEY` | Créer une clé du même environnement dans Stripe, la déposer dans le gestionnaire de secrets puis redéployer. | Stripe ne fournit pas une double lecture applicative automatique : garder l'ancien uniquement pendant la fenêtre de déploiement si le provider l'autorise, puis le révoquer. | Les appels provider en vol peuvent échouer ou être rejoués par les mécanismes idempotents. Rollback = remettre l'ancienne clé seulement avant révocation. |
| `STRIPE_PLATFORM_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` | Créer/faire tourner le secret de signature sur l'endpoint correspondant et déployer la valeur validée. | Prévoir une fenêtre de coexistence seulement si la configuration endpoint/provider permet deux secrets ; sinon coordonner le changement pour éviter les signatures rejetées. Révoquer l'ancien après observation. | Les événements reçus pendant la fenêtre peuvent être rejetés ; utiliser la relecture Stripe et la clé d'événement existante, sans nouvelle mutation financière aveugle. |
| `CRON_SECRET` | Générer une nouvelle valeur, mettre à jour le scheduler et l'application de façon coordonnée. | Faire accepter temporairement les deux valeurs nécessiterait un changement de code non présent : ne pas le simuler dans les variables. Après bascule, retirer l'ancien du scheduler et des logs/configs. | Les crons non basculés renvoient 401. Rollback = remettre la valeur précédente partout si elle n'est pas compromise. |
| `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET` | Créer/faire tourner dans Clerk, déposer la nouvelle valeur, redéployer ; pour le webhook, mettre à jour l'endpoint concerné. | Coexistence selon la capacité de Clerk ; vérifier sessions et webhook avant révocation. | Sessions/webhooks peuvent être refusés. Ne jamais copier une valeur dans un ticket ou un log. |
| `PUBLIC_SEARCH_CURSOR_SECRET` | Générer une valeur distincte par environnement et redéployer. | Pas de double lecture prévue : les curseurs signés avant rotation deviennent invalides. Retirer l'ancien après propagation. | Les anciens curseurs expirent fonctionnellement ; rollback = ancienne valeur avant retrait si nécessaire. |
| `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` | Créer une paire R2 avec les mêmes restrictions/bucket, configurer le worker puis vérifier une opération TEST/staging autorisée. | Coexistence possible au niveau provider pendant la bascule ; retirer/révoquer l'ancienne paire après vérification. | Les opérations en vol peuvent échouer ; le worker conserve l'idempotence et l'outbox. Rollback = ancienne paire avant révocation. |
| `RESEND_API_KEY` | Créer une nouvelle clé avec le périmètre minimal, configurer le worker et tester l'envoi autorisé. | Coexistence provider possible ; révoquer l'ancienne après vérification. | Un envoi peut être ambigu : suivre le runbook notification/outbox et ne pas forcer un doublon. |

Pour chaque rotation : ouvrir un changement audité, limiter l'accès, vérifier la
présence de la nouvelle valeur sans l'afficher, déployer, observer les erreurs,
révoquer l'ancienne, puis documenter l'heure et le propriétaire. Si un secret
est compromis, suivre immédiatement le runbook dédié ; ne pas attendre une
rotation planifiée.

## Actions humaines restantes

1. Nommer un propriétaire recovery et un contact d'escalade.
2. Faire confirmer par Neon la procédure et les droits de restore/PITR, puis
   exécuter un exercice isolé autorisé.
3. Mesurer RPO/RTO par environnement et conserver le résultat sans donnée
   sensible.
4. Vérifier les permissions de rollback Vercel et les mappings scheduler/crons.
5. Répéter l'exercice après toute migration classée `BACKUP_REQUIRED` ou
   `EXPAND_CONTRACT_REQUIRED`.
