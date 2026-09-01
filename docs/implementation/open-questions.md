# Questions ouvertes

Ces sujets ne doivent pas être tranchés implicitement dans le code.

| Sujet | Décision nécessaire avant | Propriétaire | Statut |
| --- | --- | --- | --- |
| Fournisseur d'identité OIDC | Lot 1 | Produit / technique | Résolu — ADR-006 (Clerk) |
| ORM et stratégie de migrations | Lot 0 | Technique | Résolu — ADR-004 (Drizzle ORM + Drizzle Kit) |
| Prestataire d'hébergement MVP | Lot 0 | Technique | Résolu — ADR-005 (Vercel + Neon, région européenne) |
| Mode Stripe Connect et responsabilité juridique | Stripe LIVE | Direction / juridique / finance | Décision technique acceptée — destination charges mono-loueur + `application_fee_amount`, controller properties sans type legacy (ADR-010). Restent à valider : settlement merchant, `on_behalf_of`, frais, soldes négatifs, remboursements et litiges. Commission obligatoire avant initiation. |
| Politique d'annulation par défaut | Stripe LIVE / production | Produit / juridique | Décision produit rendue — validation juridique requise avant activation en production ; ne bloque pas l'implémentation technique Stripe TEST du Lot 5. |
| Stratégie de caution par catégorie | ADR caution séparé / Stripe LIVE | Produit / juridique | Ouvert — explicitement séparée du paiement de location dans l'ADR-010 ; ne bloque pas les tests Stripe du paiement de location, mais doit être décidée avant usage réel si le pilote exige une caution. |
| Taxes, facturation et rôle légal d'Uttily | Lot 5 / Stripe LIVE | Finance / juridique | Ouvert — nécessaire avant toute initiation réelle ; le résolveur Lot 5 doit produire `APPLIED` ou `NOT_APPLICABLE`, jamais conserver `UNDETERMINED` (ADR-010). |
| Compensation des paiements confirmés tardivement | Stripe LIVE | Produit / paiement / juridique | Décision technique acceptée — remboursement intégral idempotent, inversion du transfert et restitution de la commission, sans réallocation. Restent à valider : délai/message client, frais Stripe et notifications (ADR-010). |
| Catégories globales vs par organisation | Lot 2 | Produit / technique | Résolu — catégories globales (taxonomie partagée gérée par l'admin Uttily) |
| Destination et partenaires pilotes confirmés | Premier lancement public configuré | Direction / commercial | **Partiellement résolu par G8B-3A** — France comme marché, Lyon première zone commerciale, particuliers en location ponctuelle, vélos de ville et électriques, cible de deux loueurs et vingt vélos. Aucun partenaire n'est encore engagé ; cela bloque le contenu réel G8B-3C et le Go commercial, pas le kit d'onboarding G8B-3B. |
| Livraison ou retrait uniquement au pilote | Lot 1 | Produit | Résolu — retrait en établissement uniquement au MVP |
| Langues initiales | Lot 7 | Produit | Résolu — FR + EN dès le lancement. ADR-017 révisé (2026-08-07). Le contenu rédigé par les loueurs n'est pas automatiquement traduit ; le traitement du contenu manquant dans une langue reste à préciser. |
| Rôles autorisés pour les opérations terrain (préparer, remettre, réceptionner) | Lot 6 use cases | Produit / technique | Résolu — ADR-011 §8 : tous les membres actifs (OWNER, ADMIN, MANAGER, STAFF) autorisés pour le MVP |
| Annulation autorisée après READY_FOR_PICKUP ? | Lot 6 use cases | Produit / juridique | Ouvert |
| Quels statuts opérationnels peuvent passer à REFUNDED ? | Lot 6 use cases | Produit / juridique | Ouvert |
| Relation exacte entre CANCELLED et REFUNDED | Lot 6 use cases | Produit / juridique | Ouvert |
| Traitement du no-show (client ne se présente pas au retrait) | Lot 6 use cases | Produit / juridique | Ouvert |
| Renforcement de l'invariant append-only de audit_log en base (trigger PostgreSQL) | Lot 6 groupe ultérieur | Technique | **Résolu par ADR-016 (Accepted)** — Option A acceptée : FK `ON DELETE RESTRICT` + trigger bloquant UPDATE/DELETE sur `audit_log`. Implémentée dans G5J-B (migration 0030, trigger, tests dédiés). Le MVP ne prend en charge que le soft-delete utilisateur ; toute suppression dure est hors périmètre. |
| Politique RGPD de suppression/anonymisation des utilisateurs (hard-delete, webhook Clerk `user.deleted`) | Avant tout hard-delete ou lancement production | Produit / juridique | Ouvert — ne bloque pas G5J-B (le MVP n'utilise que le soft-delete). Bloque tout futur hard-delete, webhook Clerk `user.deleted` destructif, ou lancement production sans politique de rétention. Ne remet pas en cause le soft-delete du MVP ni l'Option A d'ADR-016. Si un hard-delete devient nécessaire : (1) refuser la suppression si des entrées d'audit existent (comportement Option A), (2) anonymiser `actor_user_id` via snapshot/pseudonymisation (nouvel ADR ou amendement), ou (3) supprimer les entrées d'audit (violation append-only, non recommandé). |

## G7B — Réserves après gel du contrat MVP

| Sujet | Décision nécessaire avant | Propriétaire | Statut |
| --- | --- | --- | --- |
| Ville commerciale (premier lancement public configuré en France) | Premier lancement public configuré et son contenu | Direction / commercial | Ouvert — bloque ce premier lancement/contenu public configuré, pas les fondations G7C-R3–G7H. Recontextualisé : France première activation, architecture mondiale, activation pays explicite fail-closed. |
| Publication juridique des termes | Publication des termes et activation production G7F | Juridique / produit | Ouvert — bloque les termes publics et l'activation production G7F, pas le socle G7C–G7E. Aucune validation juridique n'est affirmée. |
| Consentement, rétention et agrégation analytics | Activation production G7H | Juridique / privacy / produit | Ouvert — bloque la seule activation production G7H (envoi d'événements `PRODUCTION`), pas G7C–G7G. Les fondations techniques G7H-A sont implémentées (ADR-022, migration 0035, module Core product-analytics) mais l'activation production reste soumise à validation privacy et juridique. Aucune validation privacy ou juridique n'est affirmée. |
| Images publiques : CDN/vendor, limites finales et politique d'upload | Livraison réelle d'images ou upload G7F | Technique / produit | **Résolu par ADR-026 (G8B-1)** — bucket R2 privé, upload serveur authentifié, validation des octets réels JPEG/PNG/WebP, 10 MiB max, 200–8000 px, identifiant public séparé et route applicative contrôlée avec cache borné. Un CDN externe dédié pourra remplacer la route sans modifier le contrat public. |
| Workflow complet de maintenance | Futur workflow de maintenance | Produit / opérations | Ouvert — ne bloque pas le signal minimal G7G ; bloque seulement le workflow de maintenance ultérieur. |

## G7B-R3 — Questions ouvertes après arbitrage produit (2026-08-07)

| Sujet | Décision nécessaire avant | Propriétaire | Statut |
| --- | --- | --- | --- |
| Traduction du contenu libre des loueurs (FR+EN) | G7E/G7F affichage multilingue | Produit | Ouvert — bloque G7E/G7F affichage multilingue. Aucune traduction automatique opaque. |
| Fournisseur de géocodage final et droits de stockage/cache | G8B-2B géocodage réel | Technique / juridique | **Partiellement résolu par ADR-027 et le benchmark G8B-2B** — PostgreSQL/PostGIS est retenu pour le runtime canonique et hors ligne. Photon reste un candidat d'enrichissement (meilleur score mesuré), mais son hébergement, ses droits de réutilisation et le cache doivent être validés avant toute ingestion ; IGN n'est pas retenu comme moteur primaire. |
| Calibration de l'élargissement géographique | G8B-2D | Technique / produit | Partiellement résolu par ADR-027 — paliers initiaux 10/25/50 km acceptés et alternatives toujours explicites. Les seuils de déclenchement selon le nombre d'offres restent à calibrer avec les données du pilote. |
| Règles juridiques exactes des annulations horaires (30 min) | Activation production G7P-B/G7D | Juridique / produit | Ouvert — bloque activation production. Fenêtre gratuite de 30 min après confirmation si début ≥ 2 h, validation juridique requise. |
| Modification d'une réservation entraînant un changement de prix | G7P-B modifications | Produit / paiement / juridique | **Résolu par ADR-023 (Accepted le 2026-08-10)** — conception approuvée pour G7M/G7P-C : amendements append-only sur réservation CONFIRMED uniquement, trois types NEUTRAL/SUPPLEMENT/REFUND, projection canonique `getEffectiveBooking`, hold delta-segment 10 min pour SUPPLEMENT, application atomique directe pour NEUTRAL/REFUND, dette de remboursement visible et auditée, UI client minimale réutilisant Stripe Elements. OWNER/ADMIN/MANAGER uniquement, EUR uniquement, pas de modification à partir de READY_FOR_PICKUP. Implémentation terminée et fusionnée sur main (G7M C1–C5). La politique proposée de remboursement split (delta entre états effectifs, composant par composant) est formalisée dans `ADR-030`, sans valoir approbation externe. Restent à valider : mentions légales des documents amendés, politique fiscale des suppléments/remboursements, exécution provider et délai/message client en cas de refund échoué. |
| Futures devises et conversion | Activation pays hors EUR | Produit / finance / juridique | Ouvert — bloque activation pays hors EUR. Architecture monétaire compatible, aucune conversion au lancement. |
| Fiscalité par pays | Activation pays hors France | Finance / juridique | Ouvert — bloque activation pays hors France. |
| Limites et traitement technique des images | G7F-A2/G7F-B | Technique / produit | **Partiellement résolu pour G7F-A2** — limites techniques verrouillées pour G7F-A2 (ADR-020 §F.2) : JPEG/PNG/WebP, byte_size > 0 AND <= 10485760 (10 MB), dimensions 200–8000 px, implémentées via CHECK constraints nullables. Ajustables par migration future. Règles qualité produit (modération, cadrage, re-encoding EXIF) reportées à G7F-B. Trois photos obligatoires avant publication, consignes par catégorie reportées à G7F-B. |
| Règles détaillées des forfaits traversant minuit | G7P-A | Produit / technique | Ouvert — bloque G7P-A si non résolu. |

## G5A — Documents transactionnels

Questions ouvertes issues de l'ADR-013 (groupe de décision et de conception uniquement). Toutes doivent être résolues avant l'implémentation des groupes G5B à G5F.

| Sujet | Décision nécessaire avant | Propriétaire | Statut |
| --- | --- | --- | --- |
| Statut légal du « reçu » et distinction avec une facture fiscale | G5C / G5D | Finance / juridique | Ouvert — le reçu atteste d'un encaissement mais ne constitue pas une facture fiscale ; la frontière exacte et les mentions obligatoires doivent être définies. |
| Identité légale de l'émetteur des documents (Uttily vs loueur) | G5B / G5C | Direction / juridique | Ouvert — détermine le SIRET, RCS et mentions légales affichés sur la confirmation, le contrat et le reçu. |
| Mentions contractuelles obligatoires dans le contrat de location | G5C | Juridique | Ouvert — clauses de responsabilité, assurance, caution, procédure en cas de dommage, juridiction compétente. |
| Politique de numérotation des documents (séquentiel, UUID, format lisible) | G5B / G5C | Produit / technique | Ouvert — les documents portent un identifiant lisible par le client ; le format et la séquence restent à définir. |
| Durée de conservation des documents (RGPD) | G5D | Juridique | Ouvert — rétention minimale légale, droit à l'effacement, politique d'expiration des binaires dans le stockage objet. |
| Fournisseur de stockage objet (S3, Supabase Storage, etc.) | G5D | Technique | **Résolu par ADR-014** — Cloudflare R2, juridiction `eu`, bucket privé, API compatible S3. Les adapters R2 (`apps/worker/src/adapters/r2-object-storage.ts`) et Resend (`apps/worker/src/adapters/resend-transactional-email-sender.ts`) sont implémentés et testés, et câblés dans `createWorkerDependenciesFromEnv` depuis G5H-C2C-B3. |
| Fournisseur d'email transactionnel (Resend, Postmark, SES, etc.) | G5E | Technique | **Résolu par ADR-014** — Resend (Resend Pro pour le lancement commercial ; Free en dev/staging). Les adapters R2 (`apps/worker/src/adapters/r2-object-storage.ts`) et Resend (`apps/worker/src/adapters/resend-transactional-email-sender.ts`) sont implémentés et testés, et câblés dans `createWorkerDependenciesFromEnv` depuis G5H-C2C-B3. |
| Besoin de signature électronique pour le contrat | G5C / G5D | Juridique / produit | Ouvert — détermine si le contrat nécessite une signature qualifiée, avancée ou simple, et le fournisseur associé. |
| Politique de téléchargement et durée des URLs signées | G5D | Produit / juridique | Ouvert — durée de validité des URLs signées, nombre de téléchargements autorisés, accès hors ligne. |
| Mentions TVA sur le reçu (si taxStatus = APPLIED) | G5C / G5D | Finance / juridique | Ouvert — dépend de la décision fiscale globale (cf. question « Taxes, facturation et rôle légal d'Uttily ») ; le reçu n'est pas une facture mais peut devoir afficher le taux. |
| Logo et branding sur les documents | G5C | Produit | Ouvert — branding Uttily, branding loueur, ou co-branding ; assets graphiques et charte. |
| Conditions générales de vente/usage à inclure dans la confirmation | G5C | Juridique / produit | Ouvert — inclusion intégrale, résumé ou référence ; version et lien persistant. |
| Données à figer au moment de BOOKING_CONFIRMED vs au premier traitement du worker | G5B/G5C | Technique/produit | Ouvert — déterminer si certaines données doivent être snapshotées dans la transaction de confirmation plutôt qu'au premier traitement du worker. |
| Exigence d'idempotence du fournisseur email | G5E | Technique | **Résolu par ADR-014 + G5H-C1 (ADR-013 §13)** — Resend supporte `providerIdempotencyKey` nativement dans sa fenêtre documentée de 24 h (même clé + même payload → même email id ; payload différent → 409 `invalid_idempotent_request` ; concurrent → 409 `concurrent_idempotent_requests` temporaire). Politique validée et conçue finalement dans G5H-C1 : retry automatique strictement < 23 h (cutoff `PROVIDER_IDEMPOTENCY_WINDOW_SECONDS = 82 800`), puis fail-closed avec état `REQUIRES_MANUAL_REVIEW` et intervention manuelle. **Retry idempotent des résultats `UNCERTAIN` < 23 h clarifié** : un résultat incertain avec âge < 23 h ET `attempts < MAX_ATTEMPTS` est retryé automatiquement avec exactement la même `providerIdempotencyKey` et le même payload (Resend déduplique dans la fenêtre 24 h). `REQUIRES_MANUAL_REVIEW` n'est atteint que si âge ≥ 23 h (cutoff, `failure_code = 'EMAIL_RETRY_WINDOW_EXPIRED'`) ou `MAX_ATTEMPTS` atteint avec résultat incertain (`failure_code = 'PROVIDER_RESULT_UNCERTAIN'`, jamais `FAILED` car l'envoi peut avoir réussi). Contrat Core `EmailSendResult` (discriminated union) verrouillé avec try/catch défensif dans le pipeline Core. **Migration 0029 unique transactionnelle** livrée (G5H-C2A) (remplacement contrôlé des enums via rename + recreate + cast texte + drop old dans une seule migration — cible PostgreSQL 16, journal 28 → 29 migrations PAS 30, découpage en deux fichiers interdit car le runner Drizzle drizzle-orm 0.36.4 exécute toutes les migrations en attente dans une transaction commune). **Budget de retry email séparé** : basé exclusivement sur `outbox_effects.attempt_count` de l'effet `SEND_EMAIL` (pas `outbox_events.attempt_count` qui est un compteur de claims/observabilité). **Finalizer DB-only** : helper indépendant pour crash après MAX_ATTEMPTS (`PROVIDER_RESULT_UNCERTAIN`) et cutoff 23 h sans appel (`EMAIL_RETRY_WINDOW_EXPIRED`), aucun appel fournisseur, `FOR UPDATE SKIP LOCKED`, invariant absolu aucune 6e requête fournisseur. **Invariant de réservation atomique** Phase B (lock + vérifications + incrément + timestamp + commit avant appel). Machine d'états exhaustive (35 cas). Résolution manuelle atomique future (use case administratif, pas de SQL manuel partiel). Implémentation livrée (G5H-C2A/C2B/C2C-A). Câblage production livré G5H-C2C-B3. Au-delà de 24 h, la documentation officielle ne garantit plus la déduplication. L'adapter Resend est câblé au worker depuis G5H-C2C-B3. |
| Politique en cas d'objet existant avec checksum différent | G5D | Technique | Ouvert — anomalie durable (`FAILED`) ou écrasement contrôlé ; l'écrasement est interdit par défaut. |
| Régénération d'une nouvelle version documentaire | G5C/G5D | Produit/juridique | Ouvert — politique de versioning des documents, circonstances de régénération, conservation des versions antérieures. |
| Webhooks de délivrabilité et bounce (reporté à un groupe futur) | Groupe futur post-G5E | Technique/produit | Ouvert — les webhooks de bounce et de délivrabilité sont reportés à un groupe futur ; `notification_delivery_status` inclut `PENDING \| SENT \| FAILED \| REQUIRES_MANUAL_REVIEW` (G5H-C1, ADR-013 §13) ; pas de `BOUNCED` jusqu'à décision. |

## Décisions déjà prises

- Professionnels uniquement au lancement.
- Panier mono-loueur.
- Allocation immédiate des exemplaires.
- Hold temporaire avant paiement.
- PostgreSQL comme autorité de disponibilité.
- Next.js full-stack et monolithe modulaire au départ.
- ORM : Drizzle ORM + Drizzle Kit (ADR-004).
- Hébergement MVP : Vercel + Neon, région européenne (ADR-005).
- Authentification : Clerk (OIDC) ; Uttily reste source de vérité des rôles (ADR-006).
- MVP pilote : retrait en établissement uniquement, pas de livraison ni point relais.
- Invitations : table `organization_invitations` distincte, aucun utilisateur créé avant acceptation.

## Recherche par intention — configurations de groupe (2026-08-31)

La nouvelle barre conserve `peopleCount` comme contexte visible, sans calculer de
quantité, de capacité ou de prix de groupe. Avant les recommandations V3–V5,
Produit doit valider avec Technique :

- l'autorité et les catégories prioritaires des capacités par variante (places,
  adultes/enfants, contraintes de poids et de sécurité si applicables) ;
- les accessoires réellement inclus, obligatoires ou optionnels et leur stock ;
- les combinaisons autorisées chez un seul loueur et la façon de les classer ;
- le contrat de prix et de disponibilité par configuration complète.

**Statut : ouvert, bloquant pour la composition automatique, pas pour l'UX ni
les synonymes livrés.** Aucune capacité n'est déduite d'un nom de produit.
Une ADR est nécessaire avant schéma et moteur. Voir
[home-search-next-level.md](home-search-next-level.md).

## Phase 2 — Taxonomie commerciale outdoor (2026-09-01)

| Sujet | Décision nécessaire avant | Propriétaire | Statut |
| --- | --- | --- | --- |
| Périmètre des univers et familles commerciales | Toute activation de famille | Produit / direction | **Résolu par ADR-035** — quatre univers fermés ; `bike`, `kayak`, `canoe`, `surf`, `ski` et `snowboard` actifs, autres familles pagaie/neige et catégories hors périmètre explicitement exclues. |
| Activation de la famille `kayak` | Lot d'activation kayak | Produit / technique / juridique | **Résolu le 2026-09-01** — `kayak` est `ACTIVE`, sa catégorie canonique est seedée par migration 0051, la fixture `kayak-dev` l'utilise et les parcours génériques sont validés ; aucun attribut ou accessoire nouveau n'est requis. |
| Activation de la famille `surf` | Lot d'activation surf | Produit / technique / juridique | **Résolu le 2026-09-01** — le socle `surf` est `ACTIVE` avec cinq sous-types descriptifs, sans migration ni champ spécialisé nouveau ; PR #45 et CI complète verte, Browser acceptance Clerk TEST compris. |
| Activation de la famille `ski` | Lot d'activation ski | Produit / technique / juridique | **Résolu le 2026-09-01** — `ski` est `ACTIVE` avec `alpine`, `touring` et `cross-country` comme sous-types descriptifs ; la catégorie était déjà seedée, aucun champ, migration ou accessoire autonome n'est ajouté. |
| Activation de la famille `snowboard` | Lot d'activation snowboard | Produit / technique / juridique | **Résolu le 2026-09-01** — `snowboard` est `ACTIVE` sous un seul slug via la migration 0052 ; aucun sous-type, champ spécialisé, règle ski ou accessoire autonome n'est ajouté et les parcours génériques sont réutilisés. |
| Activation de la famille `canoe` | Lot d'activation canoë | Produit / technique / juridique | **Résolu le 2026-09-01** — `canoe` est `ACTIVE` sous un seul slug via la migration 0053 ; aucun sous-type, champ spécialisé, règle kayak ou accessoire autonome n'est ajouté. |
| Slug et activation de la famille paddle | Lot de préparation puis activation paddle | Produit / direction / technique | **Ouvert** — le slug historique `paddle` reste inchangé et non commercial ; `paddleboard` est une proposition non imposée, maintenue `INACTIVE`/`UNSUPPORTED`. Aucun attribut persistant démontré pour simple/tandem, rigide/gonflable, dimensions ou capacité ; une décision produit est requise avant toute migration, fixture publiée, recherche, publication ou réservation. |
| Modes, stock et prix des compléments | ADR groupes/packs avant moteur ou schéma | Produit / technique / juridique | **Partiellement résolu par ADR-035** — vocabulaire fixé (`INCLUDED`, `MANDATORY`, `OPTIONAL_FREE`, `PAID_SUPPLEMENT`, `SEPARATELY_RENTABLE`) ; comportement, stock, prix et autorisation restent ouverts. |

## Décisions produit Lot 4 (approuvées, validations juridique/finance en attente)

- Politiques d'annulation : trois politiques prédéfinies (Flexible par défaut, Modérée, Ferme). Validation juridique de la conformité et de la base remboursable requise avant activation en production.
- Prix transparent TTC : `total_amount_minor` non nullable, `tax_status = UNDETERMINED` au Lot 4, décomposition fiscale reportée au Lot 5.
- Jours civils du lieu de retrait : facturation par date civile locale, fuseau IANA du lieu.
- Devise : EUR uniquement au MVP.
- Conditions réservables : NEW, GOOD, FAIR (POOR et BROKEN exclus).
- Authentification obligatoire : `customer_user_id` non nullable, pas de checkout invité.
- Hold 10 min, marges 30 min (prep + cleanup), snapshot des marges dans le brouillon.
- Cutoff strict : `ACTIVE` expiré jamais convertible, `PAYMENT_PROCESSING` exclu du batch normal, réconciliation dédiée, compensation idempotente.
- Montants : PostgreSQL `bigint`, Drizzle `bigint({ mode: "number" })`, TypeScript `number`, `Number.isSafeInteger` aux frontières.

## G7F-A1 — Questions ouvertes après conception ADR-020 (2026-08-08)

Questions spécifiques non tranchées issues de la conception ADR-020 (métadonnées
photo et gate de publication). Les questions générales « Images publiques :
CDN/vendor, limites finales et politique d'upload » (G7B) et « Limites et
traitement technique des images » (G7B-R3) restent valables ; les questions
ci-dessous sont les sous-points granulaires à résoudre avant ou pendant
G7F-A2/G7F-B. **Mise à jour Round 2** : les limites techniques sont
verrouillées pour G7F-A2 (ADR-020 §F.2) et pourront être ajustées par migration
future.

| Sujet | Décision nécessaire avant | Propriétaire | Statut |
| --- | --- | --- | --- |
| Limites finales de taille par photo (min/max bytes) | G7F-A2 implémentation ou G7F-B upload réel | Technique / produit | **Résolu pour G7F-A2** — `byte_size > 0 AND <= 10485760` (10 MB), implémenté via CHECK constraint nullable. Ajustable par migration future. |
| Limites finales de dimensions (min/max pixels) | G7F-A2 implémentation ou G7F-B upload réel | Technique / produit | **Résolu pour G7F-A2** — `200–8000` px, implémenté via CHECK constraint nullable. Ajustable par migration future. |
| Formats autorisés (JPEG/PNG/WebP uniquement ? HEIC/AVIF ? Refus SVG/GIF/BMP/TIFF confirmé ?) | G7F-B upload réel | Technique / produit | **Résolu par ADR-026 (G8B-1)** — JPEG, PNG et WebP uniquement, après validation des octets réels. HEIC, AVIF, SVG, GIF, BMP et TIFF sont refusés. |
| Modération automatique (NSFW, copyright) | G7F-B upload réel ou activation production | Produit / juridique | Ouvert — modération manuelle pour le MVP ? Détection automatique reportée à G7F-B. |
| Règles précises par catégorie (nombre minimum, vues requises, angles) | G8B-3B4 / activation de chaque famille | Produit / technique | **Résolu pour le pilote vélo par ADR-031** — la catégorie `bike` exige `HERO_PROFILE`, `THREE_QUARTER_FRONT` et `SECONDARY_VIEW`, plus trois checksums distincts ; les règles des autres familles seront décidées dans leur lot d'activation. |
| Profil public et badge loueur | G8B-3B4 | Produit / privacy / technique | Calcul auditable et retrait fail-closed livrés par ADR-032. Restent à décider : données de profil complémentaires, preuve d'expérience et politique privacy. Aucun badge de performance avant données réelles. |
| Parcours et conseils locaux | G8B-3E | Produit / juridique / modération | Différé après les premiers partenaires — contenu structuré, public, actualisable et assorti d'informations de sécurité. Responsabilité, signalement, modération et suppression du contenu obsolète à décider avant implémentation. |
| Durée de conservation des objets R2 supprimés (soft delete → suppression physique) | G7F-B ou activation production | Technique / juridique | **Résolu techniquement par ADR-026 (G8B-1)** — suppression physique après le commit du soft delete, avec rejeu idempotent en cas d’échec ; une politique de rétention juridique ultérieure pourra ajouter un délai. |
| Re-encoding des images (stripper EXIF et re-encoder) | G7F-B | Technique / produit | **Résolu** — reporté à G7F-B avec `sharp`/imagor (ADR-020 §F.3). |
| URLs signées : durée exacte | G7F-B livraison réelle | Technique / produit | **Résolu par ADR-026 (G8B-1)** — aucune URL R2 signée n'est exposée ; le public passe par la route applicative contrôlée et le dashboard par une route authentifiée privée. |
