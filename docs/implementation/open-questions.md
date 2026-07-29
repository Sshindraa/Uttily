# Questions ouvertes

Ces sujets ne doivent pas être tranchés implicitement dans le code.

| Sujet | Décision nécessaire avant | Propriétaire | Statut |
| --- | --- | --- | --- |
| Fournisseur d'identité OIDC | Lot 1 | Produit / technique | Résolu — ADR-006 (Clerk) |
| ORM et stratégie de migrations | Lot 0 | Technique | Résolu — ADR-004 (Drizzle ORM + Drizzle Kit) |
| Prestataire d'hébergement MVP | Lot 0 | Technique | Résolu — ADR-005 (Vercel + Neon, région européenne) |
| Mode Stripe Connect et responsabilité juridique | Lot 5 | Direction / juridique | Ouvert — commission du brouillon = UNDETERMINED, valeur obligatoire avant snapshot de réservation confirmée |
| Politique d'annulation par défaut | Lot 5 / production | Produit / juridique | Décision produit rendue — validation juridique requise avant Lot 5 / activation en production (ne bloque pas le Lot 4 technique) |
| Stratégie de caution par catégorie | Lot 5 | Produit / juridique | Ouvert |
| Taxes, facturation et rôle légal d'Uttily | Lot 5 | Finance / juridique | Ouvert — nécessaire avant confirmation et paiements du Lot 5 ; le Lot 4 ne calcule aucune taxe (`tax_status = UNDETERMINED`) |
| Compensation des paiements confirmés tardivement | Lot 5 | Produit / paiement / juridique | Ouvert — un paiement confirmé après libération du hold déclenche une compensation idempotente ; la mécanique exacte du remboursement reste à définir |
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
