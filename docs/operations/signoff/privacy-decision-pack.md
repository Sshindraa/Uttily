# Privacy decision pack — préparation de décision DPO

**Référence de version :** document vivant ; vérifier le commit courant du dépôt
avant utilisation. Les anciennes baselines `origin/main = ...` sont historiques.
**Dernière revue de cohérence :** 2026-09-04
**Statut du pack :** `SIGNOFF = APPROVED` ✅ (Décisions formelles DPO actées le 2026-09-04)
**Identifiants référencés :** uniquement `DPO-*`
**Analytics production :** `OFF`

Ce pack consigne les arbitrages formels validés par le DPO et la Direction pour le lancement du premier pilote commercial.

## Décisions DPO validées

| ID | Question | Owner | Statut | Décision actée |
| --- | --- | --- | --- | --- |
| `DPO-001` | Finalités déclarées & bases juridiques | DPO + juridique | `APPROVED` ✅ | Finalités et bases contractuelles (Art. 6.1.b), obligations légales (Art. 6.1.c) et intérêt légitime (Art. 6.1.f) validées conformément au registre des traitements. |
| `DPO-002` | Politique de confidentialité publiée | DPO + juridique | `APPROVED` ✅ | Politique de confidentialité v1 accessible sur `/[locale]/privacy` formellement approuvée. Durées annoncées (raw analytics 90 jours / agrégats 24 mois) validées. |
| `DPO-003` | Effacement, anonymisation & rétention légale | DPO + juridique + engineering | `APPROVED` ✅ | Arbitrage souverain ADR-039 validé : pseudonymisation irréversible du compte (`users.email`, `oidcSubject`, `displayName = null`), purge Clerk, scellement probatoire 5 ans (Art. 2224 C. civ.) et 10 ans (Art. L. 123-22 C. com.). Lot 21-P2 livré. |
| `DPO-004` | Format & périmètre d'export / portabilité | DPO + engineering | `APPROVED` ✅ | Format JSON standard Art. 15 (`buildPersonalDataCopy`) et Art. 20 (`buildPortableData`) validés sans PII tierce ni secrets plateforme. Lot 21-P1 livré. |
| `DPO-005` | Sous-traitants, DPA & transferts hors-UE | DPO + juridique | `APPROVED` ✅ | 6 sous-traitants (Clerk, Stripe, Neon, Cloudflare, Resend, Vercel) formellement approuvés sous garanties DPF et SCC 2021/914 (dossier 21-P1C validé). |
| `DPO-006` | Verrou analytics production | DPO + porteur produit | `APPROVED` ✅ | Maintien strict de `PRODUCTION ANALYTICS = OFF` (ADR-022) confirmé pour toute la durée du pilote. |

## DPO decisions required

Le DPO doit répondre explicitement, sans déduire une base juridique du code :

### Finalités et bases

- finalité déclarée de l'identité et du compte ;
- finalité déclarée de la réservation, de l'allocation et du paiement ;
- finalité déclarée des communications transactionnelles ;
- finalité déclarée du support et de l'audit ;
- finalité déclarée des documents transactionnels ;
- finalité déclarée de la gestion partenaire ;
- finalité déclarée de l'analytics first-party, si elle existe pour l'environnement concerné ;
- base juridique de chaque traitement, catégorie de personne et responsable ;
- caractère obligatoire ou facultatif des champs et conséquence d'un refus.

Le tableau ci-dessous dit seulement pourquoi le système collecte techniquement
une donnée pour fonctionner. Il ne dit pas pourquoi la collecte serait licite.

### Conservation, effacement et anonymisation

Décider par catégorie : durée, point de départ, purge, archivage, sauvegarde,
exigence probatoire, données de tiers, données du loueur, documents, audit et
ledger financier. Le DPO doit distinguer :

- effacement effectif ;
- anonymisation effective et critères pour la qualifier ;
- pseudonymisation temporaire ;
- données qui doivent être conservées ;
- journalisation de la demande et de son résultat.

Aucun mécanisme d'effacement, d'anonymisation ou de portabilité client n'est
implémenté dans 21-P0. Les futurs chantiers sont uniquement nommés dans le
registre ; ils ne sont pas livrés par ce pack.

### Droits et procédures

Définir le point d'entrée et le traitement des demandes d'accès, rectification,
opposition, limitation, effacement et portabilité, ainsi que les délais,
vérifications d'identité, exclusions et réponses d'erreur.

## Data map technique

Les états de capacité sont limités à `YES`, `NO`, `PARTIAL` ou `UNKNOWN`. Ils
décrivent la capacité observée aujourd'hui pour une donnée de personne, pas une
garantie de conformité ni un engagement fournisseur.

| Data category | System/table | Sujet concerné | Pourquoi techniquement collecté | Destinataires techniques | Rétention technique actuelle | Effaçable aujourd’hui | Anonymisable aujourd’hui | Exportable aujourd’hui | Decision IDs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Identité, email, nom affiché, identifiant OIDC | Clerk → `users` | Client, membre loueur, équipe interne | Authentifier, retrouver le compte et synchroniser l'identité locale | Clerk, Uttily Web, PostgreSQL | `UNKNOWN` côté provider ; `users.deleted_at` existe mais aucune procédure d'effacement utilisateur | `PARTIAL` | `UNKNOWN` | `PARTIAL` pour les vues/exportes existants, pas pour un export client complet | `DPO-001`, `DPO-002`, `DPO-003`, `DPO-004`, `DPO-005` |
| Organisation, membership, invitation et rôle | PostgreSQL : `organizations`, `organization_memberships`, `organization_invitations` | Loueur professionnel, membres et invités | Autoriser le multi-tenant, l'onboarding, les invitations et les permissions serveur | Uttily Web, support interne autorisé, PostgreSQL | `UNKNOWN`; timestamps et quelques soft-delete existent | `PARTIAL` | `UNKNOWN` | `PARTIAL` pour le dashboard autorisé, pas un export personne complet | `DPO-001`, `DPO-002`, `DPO-003`, `DPO-004` |
| Adresse, horaires, téléphone public, géopoint | PostgreSQL : `locations`, PostGIS | Loueur, établissement, visiteurs publics | Afficher un point de retrait, filtrer les destinations et appliquer le fuseau/horaires | Uttily Web, PostGIS, support interne autorisé | `UNKNOWN`; `deleted_at` existe pour l'établissement | `PARTIAL` | `UNKNOWN` | `PARTIAL` pour l'organisation, aucun export personne | `DPO-001`, `DPO-002`, `DPO-003`, `DPO-004` |
| Catalogue, catégories, tailles, prix et disponibilités | PostgreSQL : `products`, `product_variants`, pricing, `inventory_items`, `inventory_blocks` | Loueur, opérateur et indirectement client réservant | Rechercher une offre, calculer un prix et allouer un exemplaire physique | Uttily Web, Core, PostgreSQL, support interne autorisé | `UNKNOWN`; certaines entités ont états/archive/soft-delete | `PARTIAL` | `UNKNOWN` | `PARTIAL` pour le loueur, pas un export client | `DPO-001`, `DPO-002`, `DPO-003`, `DPO-004` |
| Photos produit et clés d'objet | PostgreSQL : `product_photos` + Cloudflare R2 privé | Loueur, personnes éventuellement visibles sur une photo | Publier une offre et servir les photos via routes contrôlées | Uttily Web, Cloudflare R2, navigateur pour une offre publiée | PostgreSQL : timestamps et `deleted_at`; rétention R2 provider `UNKNOWN` | `PARTIAL` (suppression photo métier existe) | `UNKNOWN` | `NO` pour un export personne dédié | `DPO-001`, `DPO-002`, `DPO-003`, `DPO-005` |
| Brouillon, réservation, lignes, exemplaires alloués et fulfillment | PostgreSQL : `booking_drafts`, `bookings`, `booking_lines`, `booking_items`, `inventory_blocks`, fulfillment | Client et loueur ; données de tiers dans une même réservation | Maintenir le contrat de réservation, l'allocation physique, le retrait et la restitution | Uttily Web, Core, PostgreSQL, support interne autorisé | `UNKNOWN`; snapshots et événements sont persistants par conception | `NO` pour une suppression complète aujourd'hui | `UNKNOWN` | `PARTIAL` via vues support/exports existants, pas portabilité client | `DPO-001`, `DPO-002`, `DPO-003`, `DPO-004` |
| Paiement, tentatives, identifiants provider et snapshot d'acceptation | PostgreSQL : `payments`, `payment_attempts` | Client, loueur et plateforme | Suivre l'obligation de paiement, réconcilier Stripe et rattacher le paiement à la réservation | Uttily Web, Stripe, PostgreSQL, support interne autorisé | `UNKNOWN`; snapshots financiers et contractuels immuables | `NO` | `UNKNOWN` | `PARTIAL` pour support/finance, pas export client complet | `DPO-001`, `DPO-002`, `DPO-003`, `DPO-004`, `DPO-005` |
| Événements webhook et métadonnées normalisées | Stripe → PostgreSQL : `payment_webhook_events` | Client, loueur et plateforme selon l'événement | Dédupliquer, vérifier la signature, traiter les transitions dans le désordre et auditer la projection | Stripe, Uttily Web, PostgreSQL, support autorisé | `UNKNOWN`; la table est persistante et idempotente | `NO` | `UNKNOWN` | `NO` pour la personne depuis un parcours dédié | `DPO-001`, `DPO-002`, `DPO-003`, `DPO-004`, `DPO-005` |
| Refunds et amendements financiers | PostgreSQL : `refunds`, `booking_amendments`, `amendment_payments`, snapshots financiers | Client, loueur et plateforme | Suivre les remboursements/suppléments et préserver l'invariant financier | Stripe, Uttily Web/worker, PostgreSQL, support interne autorisé | `UNKNOWN`; statuts, montants et snapshots persistants | `NO` | `UNKNOWN` | `PARTIAL` pour le support finance, pas export client complet | `DPO-001`, `DPO-002`, `DPO-003`, `DPO-004`, `DPO-005` |
| Documents transactionnels et snapshots de rendu | PostgreSQL : `document_render_snapshots`, `documents` + Cloudflare R2 | Client, loueur et plateforme | Produire et retrouver confirmation, contrat et reçu cohérents avec l'état confirmé | Uttily Web/worker, Cloudflare R2, Resend, destinataire autorisé | `UNKNOWN`; snapshots immuables et clés R2 ; durée provider non vérifiée | `NO` | `UNKNOWN` | `PARTIAL` via document existant, aucun export de droits automatisé | `DPO-001`, `DPO-002`, `DPO-003`, `DPO-004`, `DPO-005` |
| Emails transactionnels, destinataire et identifiant message | Resend + PostgreSQL : `notification_deliveries`, `notifications` | Client, loueur, équipe opératrice | Envoyer confirmation, documents et alertes opérationnelles avec idempotence | Resend, worker Uttily, PostgreSQL | App `UNKNOWN`; fenêtre technique d'idempotence Resend documentée à 24 h, ce n'est pas une durée légale | `PARTIAL` côté application pour certains états, pas chez Resend | `UNKNOWN` | `NO` pour une portabilité client dédiée | `DPO-001`, `DPO-002`, `DPO-003`, `DPO-004`, `DPO-005` |
| Analytics raw pseudonyme | PostgreSQL : `product_analytics_events` | Visiteur/utilisateur potentiellement raccordable via `source_id` | Compter recherches/tentatives/confirmations et dédupliquer techniquement | Uttily Web, Core, PostgreSQL, maintenance cron interne | 90 jours calendaires UTC ; purge/agrégation câblée | `PARTIAL` (purge d'âge, pas effacement par personne) | `UNKNOWN` | `NO` (les agrégats ne sont pas un export personne) | `DPO-001`, `DPO-002`, `DPO-003`, `DPO-004`, `DPO-006` |
| Analytics agrégé | PostgreSQL : `product_analytics_daily` | Aucun sujet directement identifié dans les colonnes observées | Exposer des compteurs par jour/environnement pour le produit | Uttily Web/Core, PostgreSQL | 24 mois calendaires ; contenu limité à des compteurs | `YES` via purge d'âge technique | `UNKNOWN` (qualification DPO non déduite) | `NO` pour une personne | `DPO-001`, `DPO-002`, `DPO-006` |
| Photos/document objects | Cloudflare R2 privé | Loueur, client ou tiers représenté dans le contenu | Stocker les octets de photos et documents hors base avec clés opaques | Worker/Web Uttily, Cloudflare R2, destinataire de route contrôlée | `UNKNOWN` côté provider ; suppression photo applicative seulement pour le flux photo | `PARTIAL` | `UNKNOWN` | `NO` par capacité générale | `DPO-002`, `DPO-003`, `DPO-004`, `DPO-005` |
| Logs, audit et actions support | PostgreSQL : `audit_log`; Vercel/worker logs; vues `/internal` | Client, loueur, opérateur interne | Diagnostiquer, autoriser, tracer les mutations support et les incidents | Uttily support autorisé, Vercel, worker, PostgreSQL | `UNKNOWN` pour logs et audit ; `audit_log` append-only côté modèle | `NO` pour l'audit append-only | `UNKNOWN` | `PARTIAL` pour le support, pas un export personne | `DPO-001`, `DPO-002`, `DPO-003`, `DPO-004`, `DPO-005` |

### Traçabilité des `UNKNOWN`

Chaque `UNKNOWN` de la data map est couvert par une action ci-dessous. Une
capacité inconnue n'est pas transformée en `YES` ou `NO` par défaut.

| Zone de la data map | Owner | Verification method | Next action |
| --- | --- | --- | --- |
| Rétention, localisation et transfert chez Clerk, Stripe, Vercel, R2 et Resend | DPO + juridique | Lire les DPA, conditions, paramètres du compte et documentation officielle du tenant utilisé | Collecter URL/version/date et remplacer l'incertitude uniquement avec une preuve archivée |
| Rétention des données métier PostgreSQL : identité, organisation, location, catalogue, réservation, paiement, refund et documents | DPO + engineering | Inventorier les politiques de rétention réellement codées, les migrations et les procédures opératoires | Faire décider une durée par catégorie puis ouvrir un chantier de conservation/effacement si nécessaire |
| Anonymisation des données métier et des documents | DPO + juridique + engineering | Examiner les clés, snapshots, contraintes d'intégrité et données de tiers ; aucune qualification automatique | Définir les champs conservés/anonymisés et la méthode de preuve avant tout code |
| Rétention et anonymisation de l'analytics raw/agrégé | DPO + engineering | Relire ADR-022, le schéma et le cron ; séparer durée technique et qualification juridique | Maintenir `PRODUCTION ANALYTICS = OFF` et faire statuer sur la qualification future |
| Rétention et anonymisation des logs/audits | DPO + owner support | Examiner `audit_log`, accès `/internal`, logs Vercel/worker et leurs réglages de rétention | Faire approuver durée, accès et exceptions d'effacement ; ne pas supprimer l'audit append-only |
| Export ou effacement des données dont les cellules sont `PARTIAL` | DPO + engineering | Tester uniquement les chemins existants documentés : export financier loueur et suppression photo | Décrire le périmètre exact puis ouvrir `PRIVACY-ERASURE`, `PRIVACY-RIGHTS` ou `PRIVACY-EXPORT` après décision |

## Fournisseurs et flux à qualifier

Les systèmes à inclure dans la décision sont : Clerk, Stripe, Neon/PostgreSQL,
Vercel, Cloudflare R2, Resend, analytics first-party, support/interne,
documents transactionnels et logs/audit. Les DPA, localisations et transferts
ne sont pas déclarés ici ; ils sont suivis séparément avec owner, méthode et
action.

## Analytics production

`PRODUCTION ANALYTICS = OFF`.

Le runtime, le type et la constante de configuration empêchent l'activation
PRODUCTION dans la base actuelle. L'analytics first-party de test/développement
et la purge technique décrite dans ADR-022 ne valent pas autorisation de
collecter en production. Aucune activation ni modification de code privacy
n'est incluse dans 21-P0.

## Règle de suite technique

Après décision DPO seulement, ouvrir si nécessaire :

- `PRIVACY-ERASURE` pour effacement/anonymisation ;
- `PRIVACY-EXPORT` pour export/portabilité ;
- `PRIVACY-RIGHTS` pour accès/rectification/opposition ;
- `PRIVACY-PURPOSES-REGISTRY` pour un registre versionné ;
- `PRIVACY-ANALYTICS-PRODUCTION` pour une éventuelle activation distincte.

Aucun de ces chantiers n'est implémenté ou activé dans ce pack.
