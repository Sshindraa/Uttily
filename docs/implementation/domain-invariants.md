# Invariants métier

Ces règles s'appliquent indépendamment de l'interface, de l'API ou du worker.

## Organisations et accès

1. Une action professionnelle exige une appartenance active à l'organisation concernée et le rôle adéquat.
2. Une organisation ne peut jamais lire ni modifier les données opérationnelles d'une autre organisation.
3. Les actions d'administration Uttily sont distinctes des actions des loueurs et sont auditées.

## Stock et disponibilité

1. Un `InventoryItem` représente un unique objet physique à un instant donné.
2. Un exemplaire ne peut appartenir qu'à un établissement à la fois.
3. Deux `InventoryBlock` actifs incompatibles ne peuvent pas se chevaucher sur le même exemplaire.
4. La contrainte de disponibilité porte sur la période opérationnelle bloquée, pas seulement sur la période affichée au client.
5. La maintenance bloque la disponibilité comme une réservation.
6. Redis, cache HTTP ou interface utilisateur ne peuvent pas confirmer une disponibilité.

## Réservations

1. Une réservation confirmée référence les exemplaires qui lui sont alloués.
2. Un hold a une expiration définie et n'est convertible qu'une seule fois.
3. La confirmation de réservation est atomique : stock, réservation et événement d'outbox sont cohérents.
4. Une requête répétée avec la même clé d'idempotence ne crée jamais une seconde réservation ou un second paiement.
5. Les changements d'état suivent la machine à états définie dans `booking-and-availability.md`.

## Prix et finance

1. Un montant n'est jamais stocké en flottant.
2. La devise est obligatoire pour chaque montant.
3. La réservation confirmée conserve un snapshot intégral de prix, taxes, commission, conditions et politique d'annulation.
4. Une correction financière produit une nouvelle écriture ; elle ne modifie pas l'historique.
5. Le webhook validé du prestataire de paiement est l'autorité pour l'état externe d'un paiement.
6. La location et la caution sont deux flux distincts ; la stratégie de garantie appliquée est conservée.

## Données et opérations

1. Les photos, contrats et rapports de dommage sont rattachés à une entité, un auteur et une date.
2. Les messages, contrats et reçus sont déclenchés après la transaction principale via l'outbox.
3. Les suppressions métier sont réversibles ou auditées ; l'anonymisation RGPD suit un processus distinct.
