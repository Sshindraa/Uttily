# Documentation Uttily

| Document | Rôle |
| --- | --- |
| [Périmètre MVP](product/mvp-scope.md) | Ce qui est inclus, exclu et reporté. |
| [Business plan et stratégie](product/business-plan.md) | Vision, positionnement, pilote, modèle économique et indicateurs. |
| [Vision long terme](product/long-term-vision.md) | Option C : OS loueur, marketplace, intelligence et distribution agent-ready. |
| [Architecture](architecture/overview.md) | Structure du système et trajectoire de croissance. |
| [Réservation & disponibilité](architecture/booking-and-availability.md) | Règles de concurrence, holds et états. |
| [Modèle de données](architecture/data-model.md) | Entités métier et responsabilités. |
| [Contexte agent](implementation/agent-context.md) | Brief complet pour commencer à implémenter. |
| [Roadmap remise à niveau et nettoyage](implementation/roadmap-remise-a-niveau-nettoyage.md) | Plan priorisé de cohérence, remise à niveau, nettoyage et optimisation. |
| [Backlog](implementation/backlog.md) | Ordre des lots et critères d'acceptation. |
| [Invariants métier](implementation/domain-invariants.md) | Règles qui ne doivent jamais être violées. |
| [Parcours utilisateurs](implementation/user-flows.md) | Comportements attendus côté client, loueur et administration. |
| [Questions ouvertes](implementation/open-questions.md) | Décisions à obtenir avant les fonctionnalités concernées. |
| [État canonique des frais marketplace](operations/marketplace-fees-current-state.md) | Règle 13/7, coexistence legacy, snapshots et blocage LIVE. |
| [ADR-001](decisions/ADR-001-monolithe-modulaire.md) | Monolithe modulaire Next.js au départ. |
| [ADR-002](decisions/ADR-002-professionnels-only.md) | Lancement réservé aux loueurs professionnels. |
| [ADR-003](decisions/ADR-003-reservation-flow.md) | Allocation immédiate et hold temporaire. |
| [ADR-019](decisions/ADR-019-ai-native-global-rental-infrastructure.md) | Direction stratégique AI-native et garde-fous durables. |

## Règle de maintenance

Toute décision qui modifie le périmètre, le modèle de données, la sécurité ou le paiement doit être ajoutée sous forme d'ADR avant l'implémentation.
