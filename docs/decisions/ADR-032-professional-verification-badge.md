# ADR-032 — Badge de loueur professionnel vérifié

**Statut :** Accepted — implémentation du read model technique autorisée ; le
badge ne constitue pas une validation juridique, fiscale ou RGPD.

**Date :** 2026-08-31

## Contexte

Le pilote vélo doit pouvoir présenter la confiance accordée à une organisation
professionnelle sans transformer une valeur déclarative ou un état Stripe TEST
en preuve publique. Le statut doit être explicable, recalculable et révocable
lorsqu'un établissement ou un compte de paiement ne remplit plus les conditions.

## Décision

Uttily expose un read model serveur `getProfessionalVerification` avec trois
statuts : `eligible`, `ineligible` et `pending`. Le statut n'est pas stocké dans
une colonne mutable : il est recalculé à partir des faits transactionnels afin
de ne jamais devenir obsolète.

Les critères techniques sont fermés et versionnés (`professional-verification-v1`) :

1. l'organisation est active, non supprimée, déclarée professionnelle et porte
   une raison sociale non vide ;
2. au moins un établissement actif est publiquement listé, autorise le retrait,
   possède une adresse, des coordonnées PostGIS, un pays actif et au moins un
   horaire ;
3. le compte Stripe Connect de l'environnement demandé est `ENABLED`, avec
   `charges_enabled`, `payouts_enabled` et la capacité `transfers` actives ;
4. les tableaux Stripe `currently_due` et `past_due` sont vides ou absents.

Le domaine retourne chaque prédicat et les critères manquants. Une offre
publique ne peut afficher le badge qu'avec un compte Stripe LIVE éligible. Les
vues de staging peuvent demander l'environnement TEST pour diagnostiquer la
readiness, mais ce résultat ne doit jamais être présenté comme une vérification
publique.

## Conséquences

- aucune migration n'est nécessaire et aucun état de vérification ne peut être
  falsifié côté navigateur ;
- la disparition d'un compte LIVE opérationnel ou d'un établissement publiable
  retire automatiquement le badge au prochain calcul ;
- les validations humaines juridiques, financières et RGPD restent séparées et
  continuent de bloquer le Go LIVE selon la matrice de readiness du pilote ;
- aucune analyse d'image, métrique de performance ou preuve d'expérience n'est
  utilisée pour ce badge.
