# G8A — Déploiement Web staging et smoke test complet

**Date** : 2026-08-27 — rapport historique
**Statut** : preuve historique conservée ; état courant ajouté ci-dessous
**Périmètre** : Vercel, Neon, Clerk TEST, Stripe TEST, worker, R2, Resend et scheduler

> Les éléments détaillés de ce rapport correspondent au smoke test connecté du
> 27 août 2026. Ils ne doivent pas être lus comme une photographie actuelle de
> staging sans consulter la section suivante.

## État courant vérifié le 30 août 2026

- Vercel `uttily-staging` sert le commit de merge `cebc640` sur
  `https://uttily-staging.vercel.app`.
- Neon `Uttily-dev`, branche `staging` : journal Drizzle à 49 migrations ; les
  migrations `0040` à `0049` ont été appliquées le 30 août 2026.
- Le parcours public recherche → résultat → page d’offre a été vérifié sur
  Annecy pour la période du 10 au 11 juin 2030 ; une offre est retournée et sa
  page est accessible.
- Le parcours authentifié Clerk/Stripe TEST a été rejoué : recherche, hold,
  checkout, confirmation, espace client, espace loueur et finances. La preuve
  actuelle ne remplace pas la vérification indépendante des logs worker/R2/
  Resend détaillée dans le rapport historique. Aucun fournisseur LIVE n’a été
  activé.

### Preuve connectée actuelle — 30 août 2026

- Utilisateur Clerk TEST : `uttily-staging-e2e+clerk_test@example.com` dans
  `Uttily Demo Rental`.
- Réservation créée sur Annecy pour le 10 juin 2030 :
  `8e71444c-828b-4754-8215-e58d0ffa839c`, statut `CONFIRMED`.
- Stripe TEST : paiement de 90,95 € confirmé.
- Finances loueur : location 85,00 €, frais plateforme 11,05 € (13 %), net
  73,95 € ; les frais client observés côté checkout sont de 5,95 € (7 %).
- Documents visibles côté client : confirmation, contrat et reçu.
- Les identifiants, secrets et fournisseurs LIVE restent hors périmètre.

Ce document clôt le déploiement Web staging après le ticket R2/Resend/worker
décrit dans `g8a-staging-r2-resend-worker-smoke-test.md`. Aucun fournisseur LIVE,
aucune donnée de production et aucun contournement d'authentification n'ont été
utilisés.

## Configuration déployée

- **Web** : projet Vercel `uttily-staging`, branche `main`, domaine
  `https://uttily-staging.vercel.app`, build prêt sur le commit `bb5384d`.
- **Neon** : preuve historique du 27 août sur le projet `Uttily-dev`, branche
  `staging`, région Frankfurt, avec 38 migrations alors présentes ;
  l'application et le worker utilisent l'endpoint pooled. L’état courant est
  celui décrit dans la section précédente.
- **Paiement** : `STRIPE_ENVIRONMENT=TEST`, `PAYMENTS_LIVE_ENABLED=false`,
  `PUBLIC_APP_URL` égal au domaine staging. Depuis `22-B0`, les nouveaux
  paiements utilisent la règle serveur fermée `split-13-7-v1`; aucune variable
  d'environnement ne porte de taux.
- **Clerk** : instance development/test, utilisateur pilote
  `uttily-staging-e2e+clerk_test@example.com`, authentifié par le flux Clerk
  réel. Dans Uttily, il est `OWNER` et `ACTIVE` dans `Uttily Demo Rental` ; les
  rôles applicatifs restent autoritaires côté base Uttily.
- **Stripe Connect** : compte TEST prêt et destinations webhook actives sur
  `/api/webhooks/stripe/connect` et `/api/webhooks/stripe/platform`.
- **Worker** : conteneur `uttily-worker-staging` sur l'hôte staging existant,
  construit avec `Dockerfile.worker`, non-root, limites CPU/mémoire et fichier
  d'environnement hors dépôt. R2 est limité au bucket staging EU et Resend aux
  droits d'envoi.
- **Scheduler** : Worker Cloudflare `uttily-staging-cron`, version déployée
  `4b014a9b-ffc5-4c3f-8aef-522fe87e279e`, déclenchement chaque minute et cible
  `https://uttily-staging.vercel.app`. Les quatre routes sont authentifiées par
  `CRON_SECRET` ; les Cron Jobs Vercel restent désactivés sur le plan Hobby.

## Smoke test connecté

Le test a été exécuté avec la session Clerk du pilote : recherche → hold →
checkout Stripe TEST → webhook signé → confirmation → worker → R2 → Resend.

| Contrôle | Preuve | Résultat |
| --- | --- | --- |
| Hold et paiement | draft `80c53b96-7c5f-44d8-9771-246f180dc77e`, paiement `115b6d81-ddcc-49ad-8b7b-1d79de4aaf5d` | `CONVERTED`, `SUCCEEDED` |
| Commission | snapshot serveur historique | `850` centimes sur `8500` centimes, règle legacy `1000 bps` ; cette preuve reste historique et n'est pas migrée rétroactivement |
| Stripe | événement `payment_intent.succeeded` reçu | webhook `PROCESSED` |
| Réservation | booking `7000b6b0-181a-4c10-8549-22ca95f05d29` | `CONFIRMED` |
| Outbox | événement `e92c167e-a364-47ed-ac64-d56d3a49847a` | `PROCESSED`, 4 effets `COMPLETED` |
| Documents | confirmation, contrat et reçu | 3 PDF générés dans R2 EU et vérifiés |
| Email | template de confirmation, destinataire sink Resend TEST | `delivered` dans Resend |

Les clés de stockage, identifiants de provider et credentials ne sont pas
reproduits ici. Le destinataire email est le sink officiel `delivered@resend.dev`;
aucune adresse réelle n'a été contactée.

## Crons et rollback

- Les appels directs aux quatre routes avec le secret staging ont répondu HTTP
  200. Le scheduler Cloudflare a ensuite été redéployé avec le domaine correct.
- Le rollback Web consiste à promouvoir la dernière deployment Vercel connue
  comme `Ready`, puis à conserver les migrations forward-only. Il ne faut pas
  modifier manuellement Neon.
- Le rollback worker consiste à arrêter le conteneur staging et relancer
  l'image précédente ; les événements outbox sont idempotents et restent
  rejouables.
- Les logs Vercel, Cloudflare, Neon, worker et Resend constituent l'observabilité
  minimale du staging. Toute erreur worker doit être traitée avant promotion.

## Contrôles de sécurité

- Aucun secret n'est versionné ni écrit dans ce document.
- Les clés Stripe utilisées sont TEST ; `LIVE` est refusé tant que les garde-fous
  ne sont pas explicitement activés.
- Le parcours ne contourne pas Clerk et n'ajoute aucune authentification factice.
- Les données du smoke test sont limitées à la branche Neon staging et aux
  fournisseurs TEST.
