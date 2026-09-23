# ADR-043 — Périmètre tarifaire du premier pilote

- **Statut** : Acceptée pour l'implémentation du périmètre pilote
- **Date** : 2026-09-10
- **Décision métier référencée** : arbitrage humain enregistré le 2026-09-04 dans `docs/operations/pilot-unblock-plan.md` et `docs/operations/signoff/legal-decision-pack.md`

## Contexte

Le moteur de tarification flexible sait calculer des plans `HOURLY`,
`FIXED_DURATION` et `DAILY`. Le premier pilote commercial ne couvre toutefois
pas les offres horaires de 30 minutes : cette variante a été exclue du pilote
initial afin de ne pas activer un parcours dont les règles contractuelles et
opérationnelles ne sont pas encore stabilisées pour la suite.

Le code et les documents doivent appliquer la même frontière. Un simple
masquage dans l'interface ne suffit pas : la recherche, le détail d'offre et le
hold transactionnel doivent converger vers le même périmètre serveur.

## Décision

Le périmètre tarifaire du premier pilote est :

- `HOURLY` : exclu ;
- `FIXED_DURATION` : autorisé si le plan est éligible ;
- `DAILY` : autorisé si le plan, les horaires et la disponibilité sont valides.

La politique est appliquée côté serveur aux trois surfaces publiques :

1. `searchPublicOffers` ne retourne pas une offre dont le seul plan éligible est
   horaire ;
2. `getPublicOfferDetails` ne calcule ni n'affiche un prix horaire dans ce
   périmètre ;
3. `createBookingDraftWithHold` refuse indirectement un hold horaire par le
   même moteur de pricing, avant toute allocation ou écriture métier.

Le moteur pur reste permissif par défaut. Les usages génériques et les phases
ultérieures peuvent donc tester ou activer les trois types de plans en
injectant une autre politique explicite. La politique pilote n'est pas une
valeur fournie par le navigateur et ne peut pas être contournée par l'UI.

## Conséquences

- Les tests du moteur conservent la couverture horaire générique.
- Le premier pilote doit disposer d'au moins un plan forfaitaire ou journalier
  compatible pour chaque offre publiée.
- La réouverture des offres horaires nécessite un nouvel arbitrage produit /
  juridique et une vérification de la checklist opérateur ; elle ne se fait pas
  en retirant un garde-fou dans un seul appelant.
- Cette décision ne constitue pas une autorisation de passage LIVE. Les
  blocages partenaires, paiements, secrets, webhooks et observabilité de
  `pilot-readiness.md` restent applicables.

