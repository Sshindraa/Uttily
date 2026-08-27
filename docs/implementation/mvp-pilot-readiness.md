# MVP Pilot Readiness — Baseline officielle après Lot 7

> **Mise à jour G8B-3A — 2026-08-27** : la France est le marché cible et Lyon
> la première zone commerciale. Le pilote vise les particuliers en location
> ponctuelle, avec deux loueurs professionnels et vingt vélos de ville ou
> électriques. Aucun partenaire n'est encore engagé. Voir
> `docs/product/g8b-3-bike-pilot-visual-trust-and-coach.md` pour le cadrage actuel ; les
> mentions historiques ci-dessous décrivent la baseline du 2026-08-15.

**Date d'établissement :** 2026-08-15
**Baseline :** `origin/main = 19653fac63a47845b904075f9dc3fabdb40ff872`
**Branche :** `codex/mvp-pilot-readiness-baseline`

## Résumé exécutif

Le MVP Uttily est **fonctionnellement implémenté**. Lot 7 est terminé : G7I (validation
transversale) est fusionné et validé sur `main` ; G7M C1–C5 (amendements financiers et
suppléments) est fusionné et validé ; le pont recherche publique → checkout est fusionné.
La CI post-merge (15 jobs parallèles) est verte en qualité, tests et build.

Le MVP n'est **pas encore prêt pour une production commerciale réelle**. La configuration
staging réelle (Vercel, Neon, Clerk, Stripe TEST, R2, Resend) n'est pas effectuée. Des
blocages externes (juridique, choix ville pilote, Stripe LIVE, analytics PRODUCTION,
géocodage réel, photos réelles) restent à lever avant tout lancement public commercial.

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
| Photos et gating publication | Upload réel G8B-1 + gate PostgreSQL | Migration 0039, validation octets, R2 privé, routes contrôlées, tests PostgreSQL | Bucket R2 photo staging et trois photos réelles | Oui pour le smoke photo staging | Oui (sans photos valides, pas de publication publique) |
| Dashboard loueur | Implémenté (G7G) | Projection Core, UI, tests, CI verte | Aucune | Non | Non |
| Multi-tenant et sécurité | Implémenté | Tests d'isolation PostgreSQL, sentinelles fail-closed, CI verte | Aucune | Non | Non |
| Worker et outbox | Implémenté (G5F, G5H-C2C) | 441 tests worker, bundle smoke-testé, CI verte | Vercel Cron staging, R2/Resend staging | Oui (cron staging) | Oui (cron production) |
| CI/CD | Configurée (15 jobs parallèles) | CI post-merge verte | Vercel staging project | Non | Oui (Vercel production) |

## Conséquence du report photo

Le code et le gate des trois photos obligatoires existent (G7F-A2 : table `product_photos`,
contraintes CHECK sur format/taille/dimensions, `PostgresPhotoPublicationGate` bloquant la
publication publique sans trois photos valides).

**Sans upload/CDN et photos valides, une offre réelle ne peut pas être publiée publiquement.**

- Cela **ne bloque pas** un staging technique avec fixtures contrôlées (photos de test
  injectées directement en base).
- Cela **bloque** un lancement public commercial réel : aucune offre ne peut atteindre le
  statut `PUBLISHED` visible publiquement sans photos valides uploadées via un CDN réel.

## Travaux restants classés par priorité

### P0 — Staging technique

- Audit des variables d'environnement (sans afficher de secrets).
- Configuration staging Vercel, Neon, Clerk, Stripe TEST, R2, Resend.
- Migrations staging appliquées.
- Smoke tests : recherche → hold → paiement TEST → confirmation.
- Smoke test dashboard loueur.
- Validation des crons et du worker avec providers de staging.
- Observabilité et rollback minimal.

### P0 — Production / légal externe

- Configuration réelle Vercel, Neon, Clerk, Stripe, R2 et Resend en production.
- Choix de la ville et des partenaires pilotes.
- Validation juridique : annulations, taxes, facturation, documents, RGPD.
- Activation Stripe LIVE.
- Activation analytics PRODUCTION soumise à validation privacy.
- Géocodage réel (choix fournisseur, validation contractuelle/privacy).
- Upload/CDN photo réel et photos valides pour publication publique.

### P1 — Expérience pilote

- Photos réelles : G8B-1 implémenté ; smoke test R2 staging encore requis.
- Calibration des seuils viewport avec données réelles.
- Traduction du contenu libre des loueurs (FR+EN).

### Volontairement reporté

- Modération automatique et consignes détaillées par catégorie restent reportées.
- Webhooks de délivrabilité et bounce (groupe futur post-G5E).
- Modération et re-encoding EXIF des images (G7F-B).

## Prochaine étape recommandée

### G8A — Staging Technical Readiness

**Périmètre proposé :**

- Audit des variables d'environnement sans afficher de secrets.
- Configuration staging Vercel / Neon / Clerk / Stripe TEST.
- Migrations staging.
- Smoke test recherche → hold → paiement TEST → confirmation.
- Smoke test dashboard loueur.
- Validation des crons et du worker avec providers de staging.
- Observabilité et rollback minimal.

**Limites explicites :**

- Aucune activation Stripe LIVE.
- Aucun upload photo réel.
- Aucune décision juridique implicite.

G8A n'est pas implémenté dans cette baseline. Il définit le prochain lot technique.
