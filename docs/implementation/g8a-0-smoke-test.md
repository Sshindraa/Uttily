# G8A-0 — Preuve du smoke test connecté

**Date** : 2026-08-26  
**Environnement** : staging Vercel, base Neon production de `Uttily-dev`  
**Fournisseurs** : Clerk TEST, Stripe TEST uniquement

## Identité et périmètre

- Utilisateur Clerk TEST dédié : `uttily-staging-e2e+clerk_test@example.com`.
- Organisation Uttily : `Uttily Demo Rental` (`uttily-demo-rental`).
- Permission Uttily : membre `OWNER` actif dans la base de données.
- Aucun contournement d'authentification ni utilisateur factice n'a été ajouté au produit.

## Parcours exécuté

| Étape | Résultat | Preuve |
| --- | --- | --- |
| Recherche | PASS — 1 offre Annecy trouvée pour le 6–7 septembre 2026 | `Kayak Lac d’Annecy`, `85,00 €` |
| Hold | PASS — exemplaire physique alloué par le parcours public | draft `568143eb-ce78-47ee-89f3-0acb0e284de5` |
| Paiement | PASS — Payment Element Stripe TEST confirmé | payment `c76ebf28-fadb-4825-b634-13710dd73577`, PaymentIntent `pi_3U8mI4BT4FohmAAF0uUNRRh7` |
| Webhook | PASS — `payment_intent.succeeded` signé reçu et traité | événement `evt_3U8mI4BT4FohmAAF0rfj4Lz5`, statut `PROCESSED` |
| Confirmation | PASS — brouillon `CONVERTED`, paiement `SUCCEEDED`, réservation `CONFIRMED` | vérification SQL Neon après livraison du webhook |

Le compte Connect TEST du loueur a été validé via l'onboarding Stripe-hosted avec des données
de test. La projection Connect a confirmé `charges_enabled=true`, `payouts_enabled=true`,
`transfers=ACTIVE` et `onboarding_status=ENABLED` avant le paiement.

## Vérifications de livraison

- [CI complète GitHub Actions](https://github.com/Sshindraa/Uttily/actions/runs/33003910905) : verte, qualité, build, PostgreSQL, Web et worker.
- [Déploiement Vercel staging](https://vercel.com/uttily/uttily-staging/G1w2ffUJyMrnbCD8Po1td3V4fU8a) : `READY`.
- [Application staging](https://uttily-staging.vercel.app) : parcours exécuté sur l'alias stable.

## Sécurité et limites

- Les clés, cartes et fournisseurs LIVE n'ont pas été utilisés.
- La carte utilisée était une carte Stripe TEST ; aucune donnée de carte n'est stockée par Uttily.
- Le webhook a été livré sur l'endpoint Connect puis l'endpoint plateforme avec validation de signature.
- G8A-0 est clôturé. Le déploiement multi-fournisseurs de staging réel (R2 et Resend notamment)
  est le lot distinct suivant : **G8A — staging réel**.
