# G8B-2B — Corpus Lyon et benchmark de résolution

**Date de mesure :** 2026-08-27  
**Corpus :** [`g8b-2b-lyon-corpus.json`](./g8b-2b-lyon-corpus.json), 12 requêtes
représentant ville, saisie partielle, quartiers, gares, aéroport, accents,
faute courante, homonyme et villes hors zone.

## Exécution

La base locale est PostgreSQL/PostGIS dans `docker-compose.yml`, migrée puis
re-seedée avec `pnpm db:seed`. Le benchmark reproductible est :

```bash
pnpm benchmark:destination
pnpm benchmark:destination --network
```

Le mode par défaut n'utilise que PostgreSQL local. L'option `--network` envoie
une requête séquentielle par cas vers les démonstrateurs publics Photon et
Géoplateforme IGN, avec une pause courte entre les requêtes. Elle ne modifie
aucune donnée Uttily et n'est pas utilisée par l'application.

## Résultats d'une exécution contrôlée

| Moteur | Disponibilité | Top-1 | Top-3 | p50 | p95 | Ressources observables |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| PostgreSQL local | 12/12 | 2/12 | 2/12 | 0,6 ms | 114,5 ms | conteneur 94,8 MiB ; base 38 MB ; table `destinations` 80 kB |
| Photon public | 12/12 | 12/12 | 12/12 | 40,5 ms | 145,0 ms | non observable depuis le client |
| IGN Géoplateforme | 12/12 | 11/12 | 11/12 | 258,4 ms | 529,8 ms | non observable depuis le client |

Les scores PostgreSQL ne sont pas directement comparables aux scores externes :
la fixture locale contient uniquement la destination canonique active Lyon. Les
deux requêtes ville sont correctement résolues ; les dix autres vérifient que
le registre ne transforme pas silencieusement un quartier, un aéroport ou une
ville non activée en destination canonique.

Photon a bien résolu les douze points géographiques. Le cas de faute sur
l'aéroport a toutefois renvoyé un hôtel voisin : la seule distance ne suffit
donc pas à garantir la bonne catégorie métier. IGN a raté `Vieux Lyon`, en
retournant des voies homonymes éloignées, et sa latence observée est supérieure.

## Décision

PostgreSQL/PostGIS est retenu comme moteur du runtime Uttily pour les
destinations activées : résultat canonique, sélection sécurisée, fonctionnement
hors ligne et autorité transactionnelle déjà en place. Aucun appel Photon ou IGN
n'est ajouté au Web ou au worker.

Photon reste le candidat externe à réévaluer pour une future phase
d'enrichissement, derrière un adaptateur fermé et un contrôle explicite des
droits de réutilisation, du cache, de l'hébergement et de la qualité sémantique.
Cette décision n'autorise ni stockage automatique de résultats externes ni
introduction d'OpenSearch ou de Redis.

Références API utilisées pour la mesure : [Photon API](https://github.com/komoot/photon/blob/master/docs/api-v1.md)
et [documentation IGN / Géoservices](https://geoservices.ign.fr/documentation/services/api-et-services-ogc/api-carto-rest).
