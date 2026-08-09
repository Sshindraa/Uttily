# ADR-016 — Renforcement de l'invariant append-only de `audit_log` en base (trigger PostgreSQL)

- **Titre** : Renforcement de l'invariant append-only de `audit_log` en base (trigger PostgreSQL)
- **Statut** : Accepted
- **Date** : 2026-08-06
- **Phase** : G5J-A (étude, décision et acceptation) + G5J-B (implémentation)
- **Décideurs** : Équipe engineering Uttily
- **Relie à** : ADR-006, ADR-011

## 1. Contexte

La table `audit_log` est déclarée append-only par convention applicative. La
migration 0008 (`packages/database/drizzle/0008_create_audit_log.sql`) contient
le commentaire explicite :

```text
-- Append-only : les actions de l'admin Uttily sont auditées (invariant §3).
-- Aucune UPDATE ni DELETE ne doit être appliquée à cette table.
```

Cependant, aucun trigger PostgreSQL n'empêche actuellement une `UPDATE` ou une
`DELETE` sur les lignes de `audit_log`. L'invariant repose uniquement sur la
discipline applicative : la fonction `writeAuditEntry`
(`packages/core/src/identity/audit.ts:10-27`) n'utilise que `db.insert(auditLog)`,
mais rien en base ne bloque une mutation directe.

Un précédent existe déjà dans le schéma : la table `inventory_movements`
(migration 0014, `packages/database/drizzle/0014_create_inventory_movements.sql`)
possède un trigger `prevent_update_delete_movements` qui lève une exception sur
toute tentative d'`UPDATE` ou de `DELETE`. Ce précédent démontre que le pattern
est déjà utilisé et accepté dans la base Uttily.

L'ADR-011 §7 (note sur `audit_log`, lignes 141-146) reconnaît explicitement ce
manque :

```text
La table audit_log est append-only par convention applicative. Aucun trigger
PostgreSQL n'empêche actuellement UPDATE ou DELETE sur ses lignes. La question
du renforcement de cet invariant en base (trigger bloquant UPDATE/DELETE) est
ouverte et documentée dans docs/implementation/open-questions.md.
```

La question ouverte #24
(`docs/implementation/open-questions.md`, ligne 24) documente ce travail avec le
statut « Ouvert » et la note : « audit_log est append-only par convention, mais
aucun trigger n'empêche actuellement UPDATE/DELETE ».

Le présent ADR traite cette question ouverte en phase G5J-A : étude, comparaison
d'options et décision acceptée, sans implémentation.

## 2. Invariant recherché

L'invariant retenu pour le MVP est le suivant :

- **Immutabilité stricte des lignes** face aux opérations applicatives `UPDATE`
  et `DELETE` : une entrée d'audit, une fois insérée, ne peut être ni modifiée
  ni supprimée par une opération applicative.
- `INSERT` est autorisé.
- `UPDATE` et `DELETE` sont **interdits en base** par un trigger
  `BEFORE UPDATE OR DELETE FOR EACH ROW`, pas uniquement par convention
  applicative.
- **TRUNCATE** n'est pas bloqué par ce trigger. TRUNCATE est considéré comme
  une opération privilégiée de maintenance, hors contrat applicatif. La
  stratégie concernant TRUNCATE est détaillée ci-dessous.

### 2.1 Stratégie concernant TRUNCATE

Deux possibilités ont été envisagées :

**A. Trigger `UPDATE`/`DELETE` uniquement (recommandé pour le MVP)** :
- Cohérent avec les autres tables append-only Uttily (`inventory_movements`).
- TRUNCATE reste une opération privilégiée de maintenance.
- Le rôle runtime de production ne devra pas posséder le privilège TRUNCATE.

**B. Trigger supplémentaire `BEFORE TRUNCATE FOR EACH STATEMENT`** :
- Garantie plus forte (TRUNCATE également bloqué).
- Complexifie le nettoyage des bases de tests.
- Exige un mécanisme de maintenance privilégié et contrôlé.

**Décision pour le MVP** : bloquer `UPDATE` et `DELETE` par trigger (option A).
TRUNCATE est considéré comme une opération privilégiée hors contrat applicatif.
Le futur rôle runtime de production ne devra pas posséder le privilège TRUNCATE.
TRUNCATE est conservé uniquement dans les bases PostgreSQL éphémères de tests.
La vérification des privilèges du rôle runtime sera ajoutée à la checklist avant
déploiement.

**Honnêteté technique** : un utilisateur propriétaire ou superuser PostgreSQL
reste techniquement capable de contourner l'invariant (TRUNCATE, désactivation
de trigger, etc.). L'invariant s'applique au niveau applicatif et au niveau du
rôle runtime, pas au niveau d'un superuser.

## 3. État actuel de `audit_log`

### 3.1 Schéma SQL (migration 0008)

La table `audit_log` est créée par la migration 0008 avec les colonnes
suivantes : `id` (UUID PK), `actor_user_id` (UUID, nullable), `action` (text),
`target_type` (text), `target_id` (UUID, nullable), `metadata` (jsonb),
`created_at` (timestamp with time zone). Le commentaire de migration déclare la
table append-only, mais aucun trigger n'est créé.

### 3.2 Clé étrangère `actor_user_id`

La contrainte `audit_log_actor_user_id_users_id_fk` est définie avec
`ON DELETE SET NULL` (migration 0008, ligne 17) :

```sql
ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE set null;
```

### 3.3 Schéma Drizzle

Dans `packages/database/src/schema.ts` (lignes 225-233), la définition Drizzle
de `auditLog` ne spécifie pas de `onDelete` :

```typescript
export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: uuid('target_id'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Il existe une **divergence** entre le SQL (`ON DELETE SET NULL` explicite) et le
schéma Drizzle (pas de `onDelete` spécifié). Drizzle omet `onDelete` par défaut,
ce qui correspond à `NO ACTION` en SQL, mais la migration générée a utilisé
`SET NULL`. Cette divergence devra être corrigée lors de l'implémentation.

### 3.4 Écriture

La fonction `writeAuditEntry` dans `packages/core/src/identity/audit.ts`
(lignes 10-25) est l'unique point d'écriture d'audit. Elle utilise
`db.insert(auditLog)` et n'effectue jamais d'`UPDATE` ni de `DELETE`. Elle est
appelée depuis les transitions de fulfillment, les rapports d'état et les
rapports de dommages.

### 3.5 Métadonnées

Les métadonnées stockées dans la colonne `metadata` (jsonb) ne contiennent
**actuellement aucune donnée personnelle directe** (email, nom, notes,
description libre) dans les call sites recensés (`create-damage-report.ts`,
`create-condition-report.ts`, `apply-fulfillment-transition.ts`). Les
commentaires explicites « Audit (SANS description) » et « Audit (SANS notes) »
dans le code confirment l'exclusion volontaire de ces champs libres.

Cependant, les identifiants techniques présents (`actorUserId`,
`organizationId`, `bookingId`, `inventoryItemId`) constituent des données
pseudonymes potentiellement reliables à une personne physique. L'absence de PII
directe ne signifie pas absence de donnée personnelle au sens RGPD. Cette
analyse est limitée aux call sites actuellement recensés ; toute nouvelle action
d'audit devra respecter la minimisation des données. Une validation juridique de
la rétention et de la qualification RGPD des métadonnées d'audit reste nécessaire
avant la production. Le présent ADR ne constitue pas un avis juridique.

### 3.6 Tests

Le cleanup de test dans `packages/core/src/integration/identity.test.ts` (ligne
69) utilise `db.delete(auditLog)` pour vider la table avant les tests. Or, cette
suite ne crée **aucune entrée d'audit** (aucun `insert(auditLog)` ni
`writeAuditEntry` dans ce fichier) : ce cleanup est donc **inutile** et pourra
être simplement retiré lors de G5J-B. D'autres suites de tests utilisent
`TRUNCATE TABLE ... audit_log ...` dans des bases éphémères isolées, ce qui
contourne les triggers PostgreSQL (le `TRUNCATE` n'est pas un `DELETE` ligne par
ligne et ne déclenche pas les triggers `BEFORE DELETE`).

**Note** : `audit_log` utilise des UUID comme clé primaire, donc
`RESTART IDENTITY` n'apporte aucun bénéfice. Aucune table ne référence
`audit_log` via une FK (vérifié : aucune contrainte FK pointe vers `audit_log`),
donc `CASCADE` est inutilement large et pourrait tronquer d'autres tables si de
futures FK apparaissent. Le cleanup futur devra utiliser `TRUNCATE TABLE
audit_log` (sans `RESTART IDENTITY`, sans `CASCADE`) uniquement dans une base de
test éphémère et isolée.

## 4. Conflit avec `ON DELETE SET NULL`

### 4.1 Mécanisme du conflit

La clé étrangère `audit_log.actor_user_id → users.id` utilise
`ON DELETE SET NULL`. Lorsqu'un utilisateur est supprimé par un `DELETE` dur
(hard delete) sur la table `users`, PostgreSQL exécute automatiquement un
`UPDATE` sur les lignes de `audit_log` pour mettre `actor_user_id` à `NULL`.
C'est le comportement standard de `ON DELETE SET NULL` : la base modifie les
lignes référentes pour nullifier la colonne étrangère.

Un trigger `BEFORE UPDATE OR DELETE` sur `audit_log` bloquerait cet `UPDATE`
automatique. La conséquence directe est que la suppression dure d'un utilisateur
possédant des entrées d'audit échouerait, car le trigger lèverait une exception
avant que PostgreSQL ne puisse nullifier `actor_user_id`.

### 4.2 Impact actuel (théorique)

Ce conflit est **théorique pour le MVP** car aucune suppression dure
d'utilisateur n'existe en production. Le schéma `users` utilise un pattern de
soft-delete avec une colonne `deleted_at` (`packages/database/src/schema.ts:84`).
Aucun `db.delete(users)` n'apparaît dans le code de production. Aucune fonction
`deleteUser` ou `deleteAccount` n'existe. Le webhook Clerk `user.deleted` est
mentionné dans l'ADR-006 mais n'est pas implémenté (aucun handler de webhook
n'existe). La suppression de membership (`removeMember`) effectue un soft-delete
en passant le statut à `REMOVED` (`packages/core/src/identity/memberships.ts`,
lignes 137-174), pas une suppression dure.

### 4.3 Impact futur (réel si implémentation)

Le conflit devient réel si un webhook Clerk `user.deleted` ou un use case de
suppression dure d'utilisateur est implémenté. À ce moment, la coexistence d'un
trigger bloquant `UPDATE` sur `audit_log` et de la FK `ON DELETE SET NULL`
provoquerait un échec systématique de la suppression dure pour tout utilisateur
ayant des entrées d'audit. Ce scénario doit être anticipé dans la décision.

## 5. Options comparées

Quatre options sont évaluées pour renforcer l'invariant append-only de
`audit_log` tout en traitant le conflit avec `ON DELETE SET NULL`.

### Option A — FK `ON DELETE RESTRICT` + trigger bloquant `UPDATE`/`DELETE`

Changer la contrainte `audit_log_actor_user_id_users_id_fk` de
`ON DELETE SET NULL` à `ON DELETE RESTRICT`, puis créer un trigger
`BEFORE UPDATE OR DELETE` bloquant toute mutation sur `audit_log`.

- `audit_log` devient strictement immuable : aucune `UPDATE`, aucune `DELETE`.
- La suppression dure d'un utilisateur est **refusée** si des entrées d'audit
  existent pour cet utilisateur (la FK `RESTRICT` bloque le `DELETE` sur
  `users` avant même que le trigger ne soit concerné).
- L'intégrité référentielle est conservée : `actor_user_id` pointe toujours vers
  un utilisateur existant ou est `NULL` (si l'entrée a été insérée sans acteur).
- Migration : `DROP CONSTRAINT` + `ADD CONSTRAINT` pour remplacer la FK
  `ON DELETE SET NULL` par `ON DELETE RESTRICT` (PostgreSQL ne permet pas de
  modifier l'action référentielle d'une contrainte existante en place), puis
  création de la fonction et du trigger (similaire à `inventory_movements`).
- Risque : bloque toute suppression dure future d'utilisateur tant que les
  entrées d'audit associées n'ont pas été traitées explicitement (refus,
  anonymisation, ou snapshot). C'est un comportement correct mais contraignant.
- Tests : `db.delete(auditLog)` dans `identity.test.ts:69` est inutile (la suite
  ne crée aucune entrée d'audit) et devra être retiré. Si une future suite crée
  des entrées d'audit, utiliser `TRUNCATE TABLE audit_log` (sans
  `RESTART IDENTITY`, sans `CASCADE`) dans une base de test éphémère, car le
  trigger bloquera le `DELETE` ligne par ligne.

### Option B — Suppression de la FK + trigger bloquant `UPDATE`/`DELETE`

Supprimer la contrainte de clé étrangère `audit_log_actor_user_id_users_id_fk`,
puis créer un trigger `BEFORE UPDATE OR DELETE` bloquant toute mutation.

- `audit_log` devient strictement immuable.
- La suppression d'un utilisateur est possible car il n'y a plus de FK à
  violer : PostgreSQL ne tente plus d'`UPDATE` sur `audit_log`.
- `actor_user_id` devient une **référence historique non garantie** : la colonne
  peut contenir un UUID qui ne pointe vers aucun utilisateur existant (UUID
  orphelin).
- Perte d'intégrité référentielle, incohérent avec le reste du schéma Uttily où
  toutes les FK sont explicites et contraintes.
- Migration : `DROP CONSTRAINT` sur la FK, puis création du trigger.
- Risque : `actor_user_id` peut pointer vers un utilisateur inexistant sans
  qu'aucune erreur ne soit levée. Les jointures `audit_log → users` peuvent
  retourner `NULL` silencieusement.

### Option C — Exception contrôlée autorisant uniquement `actor_user_id → NULL`

Créer un trigger `BEFORE UPDATE OR DELETE` qui bloque toute mutation, sauf si
la seule colonne modifiée est `actor_user_id` mise à `NULL`. Conserver la FK
`ON DELETE SET NULL`.

- Compatible avec `ON DELETE SET NULL` : l'`UPDATE` automatique de PostgreSQL
  (mise à `NULL` de `actor_user_id`) est autorisée car c'est la seule colonne
  modifiée et la valeur cible est `NULL`.
- `audit_log` n'est plus **strictement** append-only : une mutation est
  autorisée (la nullification de `actor_user_id`), même si elle est très
  ciblée.
- Risque : la logique du trigger est plus complexe (vérification de
  `NEW.actor_user_id IS NULL AND OLD.actor_user_id IS NOT NULL` et que aucune
  autre colonne n'a changé). Cette complexité augmente la surface d'attaque pour
  un contournement (un acteur malveillant pourrait tenter une `UPDATE` qui
  nullifie `actor_user_id` tout en modifiant d'autres colonnes, en espérant que
  le trigger soit mal écrit).
- Migration : création du trigger avec exception, pas de changement de FK.

### Option D — Snapshot/anonymisation dédiée

Conserver une identité d'audit minimale ou pseudonymisée directement dans
`audit_log` (pas de FK vers `users`), par exemple une colonne
`actor_user_snapshot` contenant un identifiant pseudonymisé ou un snapshot
minimal (nom, rôle au moment de l'action). Permet la suppression utilisateur et
l'audit immuable simultanément.

- Permet la suppression dure d'utilisateur et l'audit strictement immuable.
- `actor_user_id` (ou son équivalent) ne dépend plus de la table `users`.
- Prématuré pour le MVP : aucune donnée personnelle directe dans `metadata`
  (mais identifiants pseudonymes présents), aucune politique
  d'anonymisation existante, aucune exigence RGPD de pseudonymisation
  d'audit définie.
- Complexité : nouvelle colonne ou table d'identité pseudonymisée, logique de
  snapshot au moment de l'insertion d'audit, alimentation rétroactive des
  données existantes.
- Migration : nouvelle structure + trigger + alimentation.

### Tableau de comparaison

| Critère | Option A | Option B | Option C | Option D |
| --- | --- | --- | --- | --- |
| Intégrité d'audit | Stricte (immuable) | Stricte (immuable) | Partielle (une mutation autorisée) | Stricte (immuable) |
| Suppression/anonymisation utilisateur | Refusée si audits existent (RESTRICT) | Autorisée (pas de FK) | Autorisée (SET NULL compatible) | Autorisée (pas de FK) |
| Conformité au modèle actuel | Élevée (FK conservée, pattern inventory_movements) | Faible (perte de FK) | Moyenne (FK conservée mais trigger complexe) | Faible (nouveau modèle) |
| Complexité SQL | Faible (trigger simple + DROP/ADD CONSTRAINT) | Faible (trigger simple + DROP CONSTRAINT) | Moyenne (trigger avec exception) | Élevée (nouvelle structure) |
| Risques de contournement | Très faible (trigger simple, aucun chemin) | Très faible (trigger simple) | Moyen (logique d'exception à valider) | Très faible (trigger simple) |
| Impact sur les tests | `db.delete(auditLog)` → retrait ou `TRUNCATE` ciblé | `db.delete(auditLog)` → retrait ou `TRUNCATE` ciblé | `db.delete(auditLog)` → retrait ou `TRUNCATE` ciblé | `db.delete(auditLog)` → retrait ou `TRUNCATE` ciblé |
| Migration de données nécessaire | Aucune (aucune ligne modifiée) | Aucune (aucune ligne modifiée) | Aucune (aucune ligne modifiée) | Oui (alimentation rétroactive) |
| Conséquences multi-tenant | Aucune (audit_log est globale, pas de partitionnement par org) | Aucune | Aucune | Aucune (mais structure plus lourde) |

## 6. Décision retenue

### Option recommandée : Option A

L'Option A (FK `ON DELETE RESTRICT` + trigger bloquant `UPDATE`/`DELETE`) est
recommandée pour le MVP.

### Justification

- **Audit strictement immuable** : l'invariant le plus fort est garanti. Une
  entrée d'audit, une fois insérée, ne peut être ni modifiée ni supprimée. C'est
  la garantie la plus forte pour la traçabilité.
- **Cohérent avec le précédent `inventory_movements`** : la migration 0014 a déjà
  établi le pattern d'un trigger `BEFORE UPDATE OR DELETE` bloquant les
  mutations. L'Option A réutilise ce pattern à l'identique, garantissant une
  cohérence architecturale.
- **Aucune suppression dure d'utilisateur en production** : le MVP utilise
  uniquement le soft-delete (`deleted_at`). Aucun `db.delete(users)`, aucune
  fonction `deleteUser`, aucun webhook Clerk `user.deleted` implémenté. La FK
  `ON DELETE RESTRICT` ne bloque donc aucun flux existant.
- **Traitement explicite requis pour toute suppression dure future** : si une
  suppression dure d'utilisateur devient nécessaire (webhook Clerk
  `user.deleted`, RGPD droit à l'effacement), elle nécessitera une décision
  explicite sur le traitement des audits associés (refus, anonymisation, ou
  snapshot). C'est le comportement correct : la suppression d'un utilisateur
  avec historique d'audit ne doit pas être silencieuse.
- **La FK `ON DELETE RESTRICT` force ce traitement explicite** au lieu de
  silencieusement nullifier les références (`SET NULL`). Une nullification
  silencieuse effacerait la trace de l'acteur sans trace de décision, ce qui est
  incohérent avec un journal d'audit immuable.
- **Perte zéro d'intégrité référentielle** : `actor_user_id` pointe toujours
  vers un utilisateur existant (ou est `NULL` si l'entrée a été insérée sans
  acteur). Aucun UUID orphelin possible.

### Décision acceptée

L'Option A est **acceptée** pour le MVP. La décision produit/technique suivante
est rendue :

- Le MVP utilise uniquement le soft-delete utilisateur via `users.deleted_at`.
- Aucune suppression physique d'utilisateur n'est prise en charge dans le MVP.
- Une suppression dure doit échouer de manière fail-closed si l'utilisateur
  possède un historique d'audit (FK `ON DELETE RESTRICT`).
- L'Option A est acceptée : FK `ON DELETE RESTRICT` + blocage PostgreSQL des
  `UPDATE`/`DELETE` sur `audit_log`.
- La politique RGPD définitive de suppression/anonymisation reste une décision
  juridique séparée obligatoire avant la production.
- Un futur besoin de hard-delete devra faire l'objet d'un nouvel ADR ou d'un
  amendement explicite à ADR-016.

**Hypothèse acceptée** : « Le MVP ne prend en charge que le soft-delete
utilisateur. Toute suppression dure ou anonymisation d'un utilisateur disposant
d'un historique d'audit est hors périmètre et nécessitera une nouvelle décision
avant implémentation. »

## 7. Stratégie de migration future (sans l'exécuter maintenant)

La migration `0030_audit_log_append_only.sql` a été créée lors de **G5J-B**. La
stratégie décrite ci-dessous a été suivie lors de l'implémentation.

### Étape 1 — Remplacement de la clé étrangère

PostgreSQL ne permet pas de modifier l'action référentielle (`ON DELETE`) d'une
contrainte existante en place. La migration future devra explicitement :

1. Supprimer la contrainte `audit_log_actor_user_id_users_id_fk` (`DROP CONSTRAINT`).
2. Recréer la même FK avec `ON DELETE RESTRICT` (`ADD CONSTRAINT`).

Ces deux opérations doivent être exécutées dans une **transaction unique** pour
garantir qu'aucun état intermédiaire ne laisse la FK absente.

### Étape 2 — Création du trigger

Créer la fonction `prevent_audit_mutation()` et le trigger
`prevent_update_delete_audit`, sur le modèle de `inventory_movements`
(migration 0014, lignes 42-55) :

```text
CREATE OR REPLACE FUNCTION "prevent_audit_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log est append-only : UPDATE et DELETE interdits.';
END;
$$;

CREATE TRIGGER "prevent_update_delete_audit"
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW
  EXECUTE FUNCTION "prevent_audit_mutation"();
```

### Étape 3 — Mise à jour du schéma Drizzle

Mettre à jour `packages/database/src/schema.ts` (ligne 227) pour spécifier
explicitement `onDelete: 'restrict'` sur la référence `actorUserId`, corrigeant
la divergence actuelle entre le SQL (`SET NULL`) et le schéma Drizzle (pas de
`onDelete`).

### Étape 4 — Journal Drizzle

Le journal Drizzle (`packages/database/drizzle/meta/`) est mis à jour
uniquement lors du groupe d'implémentation, lors de la génération de la
migration 0030 via `drizzle-kit generate`.

### Étape 5 — Journal Drizzle et compteurs

L'entrée 0030 doit être ajoutée à `_journal.json` lors de la génération. Les
compteurs de migrations dans la documentation (ADR, agent-context, overview)
doivent être mis à jour (journal 29 → 30 migrations).

### Étape 6 — Documentation des privilèges du rôle runtime

Documenter explicitement dans le guide ops ou la documentation de déploiement
que le futur rôle runtime de production ne doit pas posséder le privilège
`TRUNCATE` sur `audit_log` (ni sur aucune table append-only). Ajouter cette
vérification à la checklist pré-déploiement.

### Aucune migration de données

Aucune ligne existante n'est modifiée par cette migration. Les entrées d'audit
actuelles conservent leur `actor_user_id` inchangé. La contrainte `RESTRICT`
s'applique uniquement aux suppressions futures d'utilisateurs.

## 8. Stratégie de tests PostgreSQL

Les tests suivants seront implémentés lors du groupe d'implémentation futur.
Aucun code de test n'est créé dans cet ADR.

- **INSERT autorisé** : une insertion valide sur `audit_log` réussit sans
  erreur.
- **UPDATE refusée** : une tentative d'`UPDATE` sur une ligne de `audit_log`
  lève une exception (erreur attendue du trigger).
- **DELETE refusée** : une tentative de `DELETE` sur une ligne de `audit_log`
  lève une exception (erreur attendue du trigger).
- **Suppression dure d'un utilisateur avec entrées d'audit refusée** : un
  `DELETE` sur `users` pour un utilisateur possédant des entrées d'audit est
  refusé par la FK `ON DELETE RESTRICT` (erreur attendue).
- **Suppression dure d'un utilisateur sans entrée d'audit autorisée** : un
  `DELETE` sur `users` pour un utilisateur sans entrée d'audit réussit (la FK
  ne bloque pas).
- **Soft-delete utilisateur autorisé et audit inchangé** : un `UPDATE` sur
  `users.deleted_at` (soft-delete) réussit et les entrées d'audit de cet
  utilisateur restent inchangées (`actor_user_id` toujours valide).
- **TRUNCATE fonctionne en base de test** : un `TRUNCATE TABLE audit_log`
  contourne les triggers et réussit (comportement PostgreSQL standard,
  acceptable pour le cleanup de tests en base éphémère isolée).
- **Migration depuis 0029 avec données existantes** : l'application de la
  migration 0030 sur une base contenant des entrées d'audit existantes préserve
  toutes les lignes sans modification.
- **Test de synchronisation schéma/migration** : le schéma Drizzle
  (`schema.ts`) avec `onDelete: 'restrict'` est cohérent avec la migration 0030
  générée.
- **Adaptation du cleanup de test** : `identity.test.ts:69`
  (`db.delete(auditLog)`) est **inutile** car cette suite ne crée aucune entrée
  d'audit. Le plus petit changement sûr est de **retirer** cette ligne. Si une
  future suite crée des entrées d'audit, utiliser `TRUNCATE TABLE audit_log`
  (sans `RESTART IDENTITY`, sans `CASCADE`) dans une base de test éphémère et
  isolée.

## 9. Traitement des données existantes

- Aucune donnée existante n'est modifiée par la migration future.
- Les entrées d'audit actuelles conservent leur `actor_user_id` inchangé.
- Aucune anonymisation rétroactive n'est nécessaire au niveau applicatif : les
  métadonnées ne contiennent pas de données personnelles directes (uniquement
  des IDs pseudonymes et des enums de statut). Une validation juridique reste
  requise avant production.
- Si des utilisateurs soft-deleted existent (colonne `deleted_at` renseignée),
  leurs entrées d'audit restent intactes et `actor_user_id` reste un UUID valide
  pointant vers la ligne `users` (qui n'a pas été supprimée durablement).

## 10. Rollback

En cas de besoin de retour arrière, les étapes suivantes restaurent l'état
antérieur :

1. Drop le trigger `prevent_update_delete_audit` sur `audit_log`.
2. Drop la fonction `prevent_audit_mutation()`.
3. Restaurer la contrainte `audit_log_actor_user_id_users_id_fk` en
   `ON DELETE SET NULL` (via `DROP CONSTRAINT` + `ADD CONSTRAINT`, dans une
   transaction unique).
4. Restaurer le schéma Drizzle sans `onDelete` (ou avec `onDelete: 'setNull'`
   pour aligner avec le SQL restauré).

Aucune perte de données : le rollback ne modifie aucune ligne de `audit_log` ou
de `users`. Les entrées d'audit existantes sont préservées.

## 11. Sujets hors périmètre

Les sujets suivants sont explicitement hors périmètre de cet ADR :

- **Politique de rétention d'`audit_log`** (durée de conservation, purge
  périodique) : décision produit/juridique séparée. L'append-only ne préjuge pas
  de la durée de conservation.
- **Politique d'anonymisation RGPD des utilisateurs** : décision produit/juridique
  séparée. Le droit à l'effacement et son interaction avec l'audit doivent être
  définis séparément.
- **Webhook Clerk `user.deleted` et son comportement** (soft-delete vs
  hard-delete) : implémentation séparée. L'ADR-006 mentionne ce webhook mais il
  n'est pas implémenté.
- **Pseudonymisation de `actor_user_id` (Option D)** : prématurée pour le MVP.
  Aucune donnée personnelle directe dans `metadata` (identifiants pseudonymes
  présents), aucune politique d'anonymisation existante.
- **Audit logging automatique via middleware** : pas dans le périmètre de cet
  ADR. L'audit est actuellement explicite via `writeAuditEntry`.
- **Migration 0030** : créée lors du groupe d'implémentation G5J-B, pas en
  G5J-A. Cet ADR documente la décision, pas l'implémentation.
- **Privilèges du rôle runtime de production** : la vérification que le rôle
  runtime ne possède pas le privilège TRUNCATE sera ajoutée à la checklist
  pré-déploiement lors d'un lot futur.

## 13. Implémentation G5J-B

L'Option A a été implémentée dans G5J-B :

- **Migration 0030** : `packages/database/drizzle/0030_audit_log_append_only.sql`
  - DROP + ADD CONSTRAINT (FK `ON DELETE RESTRICT`, transactionnel)
  - Function `prevent_audit_log_mutation()`
  - Trigger `prevent_update_delete_audit_log` (`BEFORE UPDATE OR DELETE FOR EACH ROW`)
- **Schéma Drizzle** : `actorUserId` mis à jour avec `onDelete: 'restrict'`
- **Journal Drizzle** : entrée 0030 ajoutée (idx 29)
- **Tests dédiés** : `packages/database/src/schema-audit-log.test.ts`
  - Structure : 30 migrations, FK RESTRICT, fonction et trigger présents
  - Comportement : INSERT autorisé, UPDATE/DELETE refusés, hard-delete fail-closed,
    soft-delete autorisé, erreur sans donnée de ligne
  - TRUNCATE : fonctionne en base éphémère (hors contrat applicatif)
  - Rejeu : 30 migrations, trigger/fonction non dupliqués
  - Migration 0029 → 0030 : données préservées, FK devenue RESTRICT
  - Rollback transactionnel : FK SET NULL restaurée en cas d'échec
- **Cleanup tests** : `identity.test.ts` — retrait de `db.delete(auditLog)` inutile
  (la suite ne crée aucune entrée d'audit)
- **Compteurs** : 29 → 30 migrations dans les tests de schéma

### Checklist pré-déploiement (rôle PostgreSQL runtime)

Le futur rôle PostgreSQL runtime de production ne doit pas posséder :
- `UPDATE` sur `audit_log` (bloqué par trigger de toute façon)
- `DELETE` sur `audit_log` (bloqué par trigger de toute façon)
- `TRUNCATE` sur `audit_log` (non bloqué par trigger — privilège à retirer)

Il doit conserver :
- `INSERT` sur `audit_log` (écriture des entrées d'audit)
- `SELECT` sur `audit_log` si nécessaire (lecture pour audit)

Aucun rôle PostgreSQL n'est créé ni aucun `GRANT`/`REVOKE` exécuté dans la
migration 0030, faute de modèle de rôles PostgreSQL approuvé dans le dépôt.

## 12. Références

- Migration 0008 (création de `audit_log`) :
  `packages/database/drizzle/0008_create_audit_log.sql`
- Migration 0014 (précédent trigger `inventory_movements`) :
  `packages/database/drizzle/0014_create_inventory_movements.sql`
- Schéma Drizzle (`auditLog`) : `packages/database/src/schema.ts:225-233`
- Fonction d'écriture d'audit : `packages/core/src/identity/audit.ts:10-27`
- ADR-006 (Clerk, webhook `user.deleted`) :
  `docs/decisions/ADR-006-clerk-oidc.md`
- ADR-011 §7 (note sur `audit_log`) :
  `docs/decisions/ADR-011-booking-fulfillment-state-machine.md`
- Question ouverte #24 :
  `docs/implementation/open-questions.md`
- Tests cleanup (`db.delete(auditLog)`) :
  `packages/core/src/integration/identity.test.ts:69-75`
