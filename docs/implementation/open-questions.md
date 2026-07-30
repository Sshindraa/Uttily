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
| Destination et partenaires pilotes confirmés | Lot 7 avant publication publique | Direction / commercial | Ouvert |
| Livraison ou retrait uniquement au pilote | Lot 1 | Produit | Résolu — retrait en établissement uniquement au MVP |
| Langues initiales | Lot 7 | Produit | Ouvert |

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
