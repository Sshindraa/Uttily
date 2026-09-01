# Documentation Uttily

| Document | Rôle |
| --- | --- |
| [Périmètre MVP](product/mvp-scope.md) | Ce qui est inclus, exclu et reporté. |
| [Taxonomie d'équipements](product/equipment-taxonomy.md) | Périmètre commercial outdoor fermé et statuts des familles. |
| [Business plan et stratégie](product/business-plan.md) | Vision, positionnement, pilote, modèle économique et indicateurs. |
| [Vision long terme](product/long-term-vision.md) | Option C : OS loueur, marketplace outdoor spécialisée, intelligence et distribution agent-ready. |
| [Architecture](architecture/overview.md) | Structure du système et trajectoire de croissance. |
| [Réservation & disponibilité](architecture/booking-and-availability.md) | Règles de concurrence, holds et états. |
| [Modèle de données](architecture/data-model.md) | Entités métier et responsabilités. |
| [Contexte agent](implementation/agent-context.md) | Brief complet pour commencer à implémenter. |
| [Roadmap remise à niveau et nettoyage](implementation/roadmap-remise-a-niveau-nettoyage.md) | Plan priorisé de cohérence, remise à niveau, nettoyage et optimisation. |
| [Roadmap opérationnelle et passage à l'échelle](implementation/roadmap-operational-readiness-and-scale.md) | Trajectoire globale : LIVE, OS loueur universel, marketplace outdoor spécialisée, intégrations, intelligence et expansion. |
| [Backlog](implementation/backlog.md) | Ordre des lots et critères d'acceptation. |
| [Invariants métier](implementation/domain-invariants.md) | Règles qui ne doivent jamais être violées. |
| [Parcours utilisateurs](implementation/user-flows.md) | Comportements attendus côté client, loueur et administration. |
| [Questions ouvertes](implementation/open-questions.md) | Décisions à obtenir avant les fonctionnalités concernées. |
| [État canonique des frais marketplace](operations/marketplace-fees-current-state.md) | Règle 13/7, coexistence legacy, snapshots et blocage LIVE. |
| [ADR-001](decisions/ADR-001-monolithe-modulaire.md) | Monolithe modulaire Next.js au départ. |
| [ADR-002](decisions/ADR-002-professionnels-only.md) | Lancement réservé aux loueurs professionnels. |
| [ADR-003](decisions/ADR-003-reservation-flow.md) | Allocation immédiate et hold temporaire. |
| [ADR-019](decisions/ADR-019-ai-native-global-rental-infrastructure.md) | Direction stratégique AI-native et garde-fous durables. |
| [ADR-030](decisions/ADR-030-split-refund-policy.md) | Politique proposée de remboursement split, soumise à validation Finance/Juridique. |
| [ADR-031](decisions/ADR-031-category-photo-requirements-and-publication-gate.md) | Slots photo obligatoires du pilote vélo ; règle générique conservée pour les autres catégories. |
| [ADR-035](decisions/ADR-035-closed-outdoor-equipment-taxonomy.md) | Taxonomie commerciale outdoor fermée et registre serveur des familles. |
| [ADR-036](decisions/ADR-036-pedalboat-preparation.md) | Préparation du pédalo sans activation commerciale. |

## Règle de maintenance

Toute décision qui modifie le périmètre, le modèle de données, la sécurité ou le paiement doit être ajoutée sous forme d'ADR avant l'implémentation.
