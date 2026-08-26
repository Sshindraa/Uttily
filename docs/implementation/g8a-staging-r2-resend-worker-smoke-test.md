# G8A — Provisionnement R2/Resend et smoke test worker

**Date** : 2026-08-26  
**Statut** : premier ticket G8A validé  
**Périmètre** : branche Neon staging, Cloudflare R2 EU, Resend TEST et worker

Ce document couvre le premier ticket du staging réel. Il ne vaut pas encore
validation du déploiement Web complet (Vercel, Clerk et parcours authentifié),
qui reste la suite du lot G8A.

## Provisionnement

- Neon : branche `staging` du projet `Uttily-dev`, région européenne.
- R2 : bucket privé `uttily-staging-documents`, juridiction européenne.
- R2 : identifiant du worker limité au bucket staging avec droits objet de
  lecture/écriture ; l'adaptateur utilise l'endpoint régional EU dérivé de
  `R2_ACCOUNT_ID`.
- Resend : domaine `sokar.tech` vérifié, expéditeur
  `Uttily <noreply@sokar.tech>`, template publié de confirmation de réservation.
- Aucun secret n'est présent dans le dépôt. Les credentials ont été utilisés
  uniquement hors dépôt et supprimés après le test.

## Smoke test connecté

Une réservation TEST isolée a été créée dans la branche Neon staging afin de
valider le traitement réel d'un événement `BOOKING_CONFIRMED.v1` par le worker.
Le destinataire utilisé est `delivered@resend.dev`, adresse de test officielle
Resend ; aucun email n'a été envoyé à un utilisateur réel.

| Contrôle | Résultat |
| --- | --- |
| Événement `BOOKING_CONFIRMED.v1` | `PROCESSED` |
| Effets outbox | `4/4 COMPLETED` |
| Documents | `3` générés et vérifiés dans R2 |
| Notification | `SENT` par Resend TEST |
| Clé Stripe / fournisseur | aucun appel Stripe ; fixture explicitement TEST |

Le succès du cycle a été confirmé par les logs du worker puis par une lecture
autoritative de Neon : l'événement est traité, les trois effets documentaires
ont un document et une clé de stockage, et l'effet email est terminé avec une
notification `SENT`.

## Corrections validées pendant le test

- L'endpoint R2 générique refusait le bucket européen ; l'adaptateur cible
  désormais explicitement l'endpoint EU et un test unitaire protège ce contrat.
- Resend a refusé une adresse de fixture `example.com` ; le smoke test utilise
  désormais exclusivement l'adresse de test Resend.
- Les essais précédents restent traçables dans l'outbox conformément à ses
  invariants append-only ; ils ne sont pas utilisés comme preuve de succès.

## Sécurité

- Clés et fournisseurs LIVE non utilisés.
- Aucun contournement de Clerk ou authentification factice ajouté au produit.
- Aucune donnée de carte stockée ou utilisée par Uttily.
- Le fichier temporaire contenant les credentials de test a été supprimé à la
  fin de la validation.

## Suite G8A

Déployer et configurer le Web staging avec Vercel, Clerk et les variables
Neon/R2/Resend, puis exécuter le parcours authentifié complet et le rollback.
