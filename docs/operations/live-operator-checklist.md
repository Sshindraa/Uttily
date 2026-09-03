# Live operator checklist — préparation de configuration

**Référence de version :** document vivant ; vérifier le commit courant du dépôt
avant exécution. Les anciennes baselines `origin/main = ...` sont historiques.
**Dernière revue de cohérence :** 2026-08-30
**Statut :** `READY_FOR_CONFIGURATION`
**Secrets :** jamais inscrits dans ce document, les logs ou un commit
**Analytics production :** `OFF`

Cette checklist ordonne la configuration et la validation opérateur. Elle ne
déclenche aucune activation par elle-même. Toute case reste non cochée tant que
la preuve correspondante n'est pas conservée dans le dossier opérationnel
autorisé.

## Séquence obligatoire

1. [ ] **Legal / Finance / DPO blockers approved** — joindre les décisions humaines datées et les documents applicables ; vérifier qu'aucune valeur de code (`v1`, `NOT_APPLICABLE`, `Uttily`, taux de commission) n'est traitée comme une approbation.
2. [ ] **Applicable documents produced** — vérifier la disponibilité des documents client/loueur, les versions, les mentions et la chaîne de consentement ; ne pas produire de texte juridique depuis ce checklist.
3. [ ] **Production secrets** — configurer les variables de production dans le gestionnaire autorisé, sans les copier dans le dépôt, un ticket, un log ou une capture ; vérifier présence/format sans afficher les valeurs.
4. [ ] **Stripe LIVE platform** — configurer l'environnement Stripe LIVE et le garde-fou d'activation (voir [`21-ops-stripe-live-activation.md`](../runbooks/21-ops-stripe-live-activation.md)) ; ne jamais réutiliser un secret TEST.
5. [ ] **Platform LIVE webhook** — créer/configurer l'endpoint Platform, fournir son secret hors dépôt et vérifier une signature/route dans l'environnement autorisé.
6. [ ] **Connect LIVE webhook** — créer/configurer l'endpoint Connect, fournir son secret hors dépôt et vérifier la projection des événements signés.
7. [ ] **Partner Connected Account LIVE** — rattacher le bon compte à l'organisation partenaire, terminer l'onboarding autorisé et vérifier côté serveur `charges_enabled`, `payouts_enabled` et l'état de transfert.
8. [ ] **Real `pnpm readiness:live`** — exécuter la commande existante `pnpm readiness:live` dans le projet/environnement autorisé ; conserver le résultat borné et non sensible.
9. [ ] **Safe smoke tests** — exécuter uniquement les scénarios autorisés (tests ping webhooks décrits dans le runbook) ; ne pas confirmer une réservation commerciale avant tous les sign-offs.
10. [ ] **Operator validation** — l'opérateur et le porteur produit signent la preuve de configuration, les contacts, le recovery et les résultats des smoke tests.

## Garde-fous

- Réutiliser `scripts/readiness-live.mjs` via `pnpm readiness:live`. Aucun nouveau validator n'est créé dans 21-P0.
- Les credentials, secrets webhook, clés R2/Resend/Clerk, URLs privées et données personnelles ne sont jamais inscrits ici.
- `PRODUCTION ANALYTICS = OFF` reste inchangé, même si les étapes LIVE sont validées.
- Une validation technique de readiness ne remplace pas une décision juridique, finance ou DPO.
- Le pilote ne devient pas `READY` tant qu'une case nécessaire reste non prouvée.

## Evidence à conserver

Conserver uniquement des preuves non secrètes : SHA déployé, environnement,
horodatage UTC, statut de la commande, codes d'erreur bornés, identifiants
fonctionnels minimisés et signataires. Ne pas déposer de secret, payload de
carte, KYC, token ou URL privée.
