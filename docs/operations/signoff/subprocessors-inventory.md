# Inventaire des sous-traitants — préparation de vérification

**Référence de version :** document vivant ; vérifier le commit courant du dépôt
avant utilisation. Les anciennes baselines `origin/main = ...` sont historiques.
**Dernière revue de cohérence :** 2026-08-30
**Statut :** `PASS` pour la préparation ; aucune conformité ou localisation n'est déclarée par Uttily
**Décision de référence :** `DPO-005`

Les fournisseurs ci-dessous sont ceux identifiables dans l'architecture et le
code du premier pilote. `TO_VERIFY` signifie qu'une vérification externe
documentée est requise. Chaque `TO_VERIFY` comporte un owner, une méthode et une
action suivante. Une région technique ou un nom de produit ne remplace pas un
DPA, une clause de transfert ou une preuve contractuelle.

| Provider | Fonction | Data categories potentielles | DPA | Data location/transfer | Owner | Verification method | Next action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Clerk | Identité/OIDC, authentification et synchronisation de l'utilisateur | Email, nom affiché, identifiant OIDC, état de vérification | `TO_VERIFY` | `TO_VERIFY` — localisation et mécanisme de transfert à confirmer pour le tenant utilisé | DPO + juridique | Vérifier le DPA/DSA et la documentation de région du compte Clerk, puis conserver URL/version/date | Obtenir la réponse contractuelle et l'attacher au dossier `DPO-005`; ne pas déclarer la couverture avant vérification |
| Stripe | PaymentIntent, compte connecté, onboarding, webhooks et refunds | Identifiants client/paiement, montant/devise, identifiants compte, événements et métadonnées minimisées ; pas de données carte stockées par Uttily | `TO_VERIFY` | `TO_VERIFY` — région, sous-traitants et transferts du compte Stripe à documenter | DPO + finance + juridique | Revoir l'accord Stripe applicable, la liste de sous-traitants et le paramétrage du compte/pays | Confirmer DPA, data residency/transfer et périmètre de données avant LIVE |
| Neon / PostgreSQL | Base transactionnelle et PostGIS | Comptes, organisations, réservations, paiements, documents, audit et analytics | `TO_VERIFY` | `TO_VERIFY` — le projet technique est documenté en `aws-eu-central-1`, mais la couverture contractuelle et les sauvegardes doivent être confirmées | DPO + owner recovery | Vérifier contrat/plan Neon, région du projet, sous-traitants, sauvegardes/PITR et mécanisme de transfert | Consigner DPA, localisation contractuelle, rétention et procédure restore autorisée |
| Vercel | Hébergement Web, déploiements et crons | Requêtes/runtime logs potentiels, variables d'environnement, métadonnées de déploiement | `TO_VERIFY` | `TO_VERIFY` — région de traitement/logs et transferts du projet production à confirmer | DPO + engineering | Vérifier contrat Vercel, data processing terms, région/log retention et réglages du projet | Documenter les résultats et supprimer toute promesse de localisation non prouvée |
| Cloudflare R2 | Stockage privé des photos et documents | Octets photo/document, clés de stockage, checksums, métadonnées techniques | `TO_VERIFY` | `TO_VERIFY` — le bucket est prévu en juridiction `eu`; cela ne prouve pas un datacenter physique ni le transfert juridique | DPO + engineering | Vérifier le contrat R2, la juridiction du bucket, les régions/replicas applicables et les clauses de transfert | Conserver la preuve du bucket/région et la qualification DPO avant données de production |
| Resend | Emails transactionnels et notifications | Adresse destinataire, contenu/document envoyé, identifiant message, statut et clé d'idempotence | `TO_VERIFY` | `TO_VERIFY` — région de traitement, rétention et sous-traitants email à confirmer | DPO + engineering | Vérifier DPA, sous-traitants, data locations et configuration domaine/compte Resend | Faire valider DPA/location/rétention avant l'envoi de messages de production |
| Uttily first-party analytics | Ledger et agrégats dans PostgreSQL | `source_id` UUID pseudonyme potentiel, événements et compteurs agrégés | `NOT_APPLICABLE` pour un sous-traitant externe | `NOT_APPLICABLE` comme transfert distinct ; dépend de la vérification Neon | DPO + engineering | Relire ADR-022 et le schéma ; vérifier séparément Neon | Maintenir `PRODUCTION ANALYTICS = OFF` jusqu'à décision DPO |
| Uttily Support / internal | Vues `/internal`, actions support et audit | Identifiants fonctionnels, états paiement/refund/notification, motif d'action | `NOT_APPLICABLE` | `NOT_APPLICABLE` comme fournisseur externe ; logs/hébergement restent à qualifier avec Vercel/worker | Owner support + DPO | Relire ADR-028, contrôle `is_platform_admin`, actions fermées et `audit_log` | Ajouter les contacts et règles d'accès au runbook interne sans exposer de secret |
| Uttily transactional documents | Snapshots de rendu, documents et outbox | Données de réservation, identité nécessaire au document, montants et références | `NOT_APPLICABLE` comme service externe distinct | `NOT_APPLICABLE` comme transfert distinct ; stockage DB/R2/Resend à qualifier séparément | Finance + DPO | Relire ADR-013/015, schéma et flux worker | Relier chaque document à ses fournisseurs effectifs et à la politique de conservation |
| Uttily audit logs | Journal append-only des actions support | Acteur, action, cible, métadonnées de raison | `NOT_APPLICABLE` | `NOT_APPLICABLE` comme service externe distinct ; hébergement DB à qualifier avec Neon | DPO + owner support | Vérifier schéma `audit_log`, actions et accès `/internal` | Faire valider la durée d'audit et les exceptions d'effacement |

## Méthode de clôture

Pour chaque ligne externe, conserver : nom du compte/projet sans secret, date de
vérification, URL ou pièce contractuelle, région ou mécanisme de transfert,
rétention annoncée, sous-traitants pertinents, owner et décision DPO associée.

Une valeur `TO_VERIFY` reste `TO_VERIFY` tant que la preuve n'est pas présente
dans le dossier de décision. Le présent inventaire ne transforme aucune ligne en
`VERIFIED` sur la seule base d'une connaissance générale du fournisseur.
