# Questions ouvertes

Ces sujets ne doivent pas être tranchés implicitement dans le code.

| Sujet | Décision nécessaire avant | Propriétaire | Statut |
| --- | --- | --- | --- |
| Fournisseur d'identité OIDC | Lot 1 | Produit / technique | Résolu — ADR-006 (Clerk) |
| ORM et stratégie de migrations | Lot 0 | Technique | Résolu — ADR-004 (Drizzle ORM + Drizzle Kit) |
| Prestataire d'hébergement MVP | Lot 0 | Technique | Résolu — ADR-005 (Vercel + Neon, région européenne) |
| Mode Stripe Connect et responsabilité juridique | Lot 5 | Direction / juridique | Ouvert |
| Politique d'annulation par défaut | Lot 4 | Produit / juridique | Ouvert |
| Stratégie de caution par catégorie | Lot 5 | Produit / juridique | Ouvert |
| Taxes, facturation et rôle légal d'Uttily | Lot 5 | Finance / juridique | Ouvert |
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
