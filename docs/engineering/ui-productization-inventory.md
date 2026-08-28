# UI productization inventory

Inventaire 21-H uniquement. Il ne crée ni primitive, ni token, ni palette, ni
design system ; ces décisions appartiennent à 21-U0.

| Pattern | Locations | Duplicated | Candidate U0 primitive | Migrate now? |
| --- | --- | --- | --- | --- |
| Shell et navigation dashboard | `apps/web/src/app/dashboard/`, `apps/web/src/components/` | Oui, composition spécifique au dashboard | App shell / navigation | NO |
| Formulaires de gestion loueur | `apps/web/src/app/dashboard/[orgId]/bikes/`, `fleet/`, `locations/`, `settings/` | Oui, champs et règles métier distincts | Field / form layout | NO |
| États de réservation et amendement | `apps/web/src/app/dashboard/[orgId]/bookings/`, `apps/web/src/app/checkout/` | Partiel, contrats métier différents | Status badge / alert | NO |
| Cartes et panneaux de flotte | `apps/web/src/app/dashboard/[orgId]/bikes/`, `fleet/`, `bookings/` | Oui, contenus et actions différents | Card / section panel | NO |
| Boutons et liens d’action | `apps/web/src/app/`, `apps/web/src/components/` | Oui, styles locaux | Button / link | NO |

Les similarités sont des candidats d'étude, pas une autorisation de migration :
aucune abstraction n'est assez générique et déjà stable pour être déplacée sans
risque fonctionnel dans ce chantier.
