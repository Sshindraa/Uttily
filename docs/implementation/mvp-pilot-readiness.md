# MVP Pilot Readiness — Baseline officielle après Lot 7

> **Mise à jour G8B-3A — 2026-08-27** : la France est le marché cible et Lyon
> la première zone commerciale. Le pilote vise les particuliers en location
> ponctuelle, avec deux loueurs professionnels et vingt vélos de ville ou
> électriques. Aucun partenaire n'est encore engagé. Voir
> `docs/product/g8b-3-bike-pilot-visual-trust-and-coach.md` pour le cadrage actuel ; les
> mentions historiques ci-dessous décrivent la baseline du 2026-08-15.

**Date d'établissement :** 2026-08-15
**Référence de version :** document de readiness vivant ; vérifier la branche et
le commit courants du dépôt avant utilisation. Les baselines et branches
mentionnées dans les archives de préparation sont historiques.
**Dernière revue de cohérence :** 2026-08-30

## Résumé exécutif

Le MVP Uttily est **fonctionnellement implémenté**. Lot 7 est terminé : G7I (validation
transversale) est fusionné et validé sur `main` ; G7M C1–C5 (amendements financiers et
suppléments) est fusionné et validé ; le pont recherche publique → checkout est fusionné.
La CI post-merge (15 jobs parallèles) est verte en qualité, tests et build.

Le MVP n'est **pas encore prêt pour une production commerciale réelle**. La configuration
staging réelle (Vercel, Neon, Clerk, Stripe TEST, R2, Resend) et le smoke test photo
G8B-1 sont désormais validés. Des blocages externes (juridique, partenaires pilotes,
Stripe LIVE, fiscalité/RGPD et décisions commerciales) restent à lever avant tout
lancement public commercial. Le Photo Coach vélo est livré comme vertical slice
technique ; son enforcement sémantique complet et le badge professionnel restent
à finaliser.

## Matrice de readiness

| Domaine | État du code | Preuve | Configuration externe requise | Bloque staging ? | Bloque production ? |
| --- | --- | --- | --- | --- | --- |
| Recherche publique | Implémenté (G7D, G7E) | 83 tests Core, 17 tests Web, CI verte | Géocodeur réel (fournisseur à choisir) | Non (fixtures contrôlées) | Oui (géocodage réel requis) |
| Pont recherche → checkout | Implémenté | Migration 0038, 31 tests Core, 17 tests Web, CI verte | Aucune | Non | Non |
| Réservation et hold | Implémenté | Tests d'intégration PostgreSQL, CI verte | Neon staging | Oui (DB staging) | Oui (DB production) |
| Paiement Stripe | Implémenté (TEST) | Tests Core/Web, CI verte | Stripe TEST keys, Clerk staging | Oui (keys TEST) | Oui (Stripe LIVE) |
| Amendements financiers (G7M) | Implémenté et fusionné | C1–C5 fusionnés, tests Core/Web/PostgreSQL, CI verte | Stripe TEST keys | Non | Oui (validation juridique fiscale) |
| Fulfillment et opérations | Implémenté (G4A, G4B) | Server Actions, tests, CI verte | Aucune | Non | Non |
| Documents transactionnels | Implémenté (G5B–G5D) | Tests unitaires + PostgreSQL, CI verte | R2 staging bucket | Oui (R2 staging) | Oui (R2 production) |
| Emails transactionnels | Implémenté (G5E, G5H) | 40 tests PostgreSQL, CI verte | Resend staging domaine | Oui (Resend staging) | Oui (Resend production) |
| Analytics | Implémenté (G7H-A/B) | Migration 0035, tests Core, CI verte | Validation privacy PRODUCTION | Non (gate staging) | Oui (validation privacy) |
| Photos et gating publication | Upload réel G8B-1 + gate PostgreSQL + Photo Coach partiel G8B-3B4 | Migrations 0039/0040, validation octets, slots persistés, R2 privé, routes contrôlées, tests PostgreSQL et composants | Photos réelles pour chaque offre pilote ; alignement de l’allow-list et gate sémantique restant | Non : smoke R2 staging validé | Oui (sans photos valides, pas de publication publique) |
| Dashboard loueur | Implémenté (G7G) | Projection Core, UI, tests, CI verte | Aucune | Non | Non |
| Multi-tenant et sécurité | Implémenté | Tests d'isolation PostgreSQL, sentinelles fail-closed, CI verte | Aucune | Non | Non |
| Worker et outbox | Implémenté (G5F, G5H-C2C) | 441 tests worker, bundle smoke-testé, CI verte | Vercel Cron staging, R2/Resend staging | Oui (cron staging) | Oui (cron production) |
| CI/CD | Configurée (15 jobs parallèles) | CI post-merge verte | Vercel staging project | Non | Oui (Vercel production) |

## État actuel des photos et du Photo Coach

Le socle photo est livré : table `product_photos`, contraintes CHECK sur
format/taille/dimensions, upload R2 réel, routes contrôlées et
`PostgresPhotoPublicationGate` bloquant la publication publique sans trois photos
`AVAILABLE` distinctes. Le smoke test staging G8B-1 a été validé le 2026-08-27.

Le Photo Coach G8B-3B4 ajoute le contrat partagé des slots, la migration `0040`,
la persistance du `slot_type`, le viseur caméra, les overlays, la checklist et la
progression. À ce stade, le gate ne vérifie pas encore un slot requis de chaque
type et l’action serveur doit encore accepter les deux noms canoniques utilisés
par l’interface (`THREE_QUARTER_FRONT`, `SECONDARY_VIEW`). Le badge de loueur
professionnel reste non implémenté.

**Une offre réelle ne peut être publiée que si elle possède trois photos valides
distinctes.** La qualité sémantique des vues et le badge ne doivent pas être
présentés comme vérifiés tant que leurs verrous serveur ne sont pas livrés.

## Travaux restants classés par priorité

### P0 — Staging technique — clôturé

Le staging G8A est déployé et validé : configuration Vercel, Neon, Clerk TEST,
Stripe TEST, R2, Resend, migrations, smoke test authentifié recherche → hold →
paiement TEST → confirmation, worker, documents, emails, crons, observabilité
minimale et rollback. La preuve détaillée est conservée dans
`docs/implementation/g8a-web-staging-deployment.md`.

### P0 — Production / légal externe

- Configuration réelle Vercel, Neon, Clerk, Stripe, R2 et Resend en production.
- Choix de la ville et des partenaires pilotes.
- Validation juridique : annulations, taxes, facturation, documents, RGPD.
- Activation Stripe LIVE.
- Activation analytics PRODUCTION soumise à validation privacy.
- Enrichissement géocodage par fournisseur externe (facultatif) : le runtime
  canonique PostgreSQL/PostGIS est livré ; les droits, l'hébergement et le cache
  restent à valider avant toute ingestion Photon/IGN.
- Photos valides et contenu réel pour chaque offre publiée.

### P1 — Expérience pilote

- Finalisation G8B-3B4 : enforcement sémantique des slots et badge professionnel.
- Calibration des seuils viewport avec données réelles.
- Traduction du contenu libre des loueurs (FR+EN).

### Volontairement reporté

- Modération automatique et consignes détaillées par catégorie restent reportées.
- Webhooks de délivrabilité et bounce (groupe futur post-G5E).
- Modération et re-encoding EXIF des images (G7F-B).

## Prochaine étape recommandée

### G8B-3B4 — Clôture du standard visuel et de la confiance

**Périmètre proposé :**

- Aligner l’allow-list de l’action serveur sur les slots canoniques utilisés par
  l’interface.
- Décider si le gate de publication exige un slot obligatoire de chaque type, puis
  appliquer cette règle dans PostgreSQL/Core avec tests d’intégration.
- Implémenter le statut du badge professionnel uniquement à partir de critères
  vérifiables, avec retrait fail-closed.
- Mettre à jour les preuves de readiness et le parcours d’onboarding.

**Limites explicites :**

- Aucune analyse d’image par IA.
- Aucun badge professionnel affiché sans calcul et preuve auditable.
- Aucune activation Stripe LIVE ni décision juridique implicite.

Le staging G8A et l’upload réel G8B-1 sont déjà validés ; ce travail est donc un
correctif de cohérence et de clôture, pas une réimplémentation du Photo Coach.
