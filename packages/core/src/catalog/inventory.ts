import { and, eq, isNull } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { inventoryItems, inventoryMovements } from '@uttily/database';
import type {
  InventoryItemRecord,
  InventoryMovementRecord,
  CreateInventoryItemInput,
  UpdateInventoryItemInput,
  TransferInventoryItemInput,
} from './types';
import { AuthorizationError } from '../identity/permissions';
import { CatalogError, isUniqueViolation } from './errors';

export async function createInventoryItem(
  db: DatabaseClient,
  input: CreateInventoryItemInput,
): Promise<InventoryItemRecord> {
  const internalSku = input.internalSku.trim();
  if (internalSku.length < 1) {
    const msg = "L'SKU interne est requis.";
    throw new CatalogError('VALIDATION', msg, { internalSku: msg });
  }

  // La cohérence multi-tenant (location.org = item.org ET variant.product.org = item.org)
  // est vérifiée par le trigger PostgreSQL before_check_inventory_org.
  // Le domaine fait une vérification préalable pour un message clair, mais
  // la contrainte SQL reste l'autorité finale face à la concurrence.

  try {
    const [row] = await db
      .insert(inventoryItems)
      .values({
        organizationId: input.organizationId,
        productVariantId: input.productVariantId,
        internalSku,
        serialNumber: input.serialNumber ?? null,
        condition: input.condition ?? 'NEW',
        status: input.status ?? 'ACTIVE',
        currentLocationId: input.currentLocationId,
        notes: input.notes ?? null,
      })
      .returning();
    if (!row) throw new CatalogError('UNKNOWN', "Échec de création de l'exemplaire.");
    return mapItem(row);
  } catch (err) {
    // Conflit SKU : violation de l'index unique partiel.
    if (isUniqueViolation(err, 'inventory_items_organization_sku_active_unique')) {
      const msg = 'Cet SKU est déjà utilisé.';
      throw new CatalogError('CONFLICT_SKU', msg, { internalSku: msg });
    }
    // Conflit serial : violation de l'index unique partiel.
    if (isUniqueViolation(err, 'inventory_items_organization_serial_active_unique')) {
      const msg = 'Ce numéro de série est déjà utilisé.';
      throw new CatalogError('CONFLICT_SERIAL', msg, { serialNumber: msg });
    }
    // Trigger check_inventory_org_consistency : cohérence multi-tenant.
    // RAISE EXCEPTION (code P0001) — pas de nom de contrainte, identification par message.
    // Message contrôlé : le trigger peut lever deux messages distincts (établissement
    // ou variante hors org), non distinguables ici. On utilise un message générique
    // pour éviter de propager err.message brut vers l'utilisateur.
    if (err instanceof Error && err.message.includes('la même organisation')) {
      throw new CatalogError(
        'VALIDATION',
        "L'établissement ou la variante n'appartient pas à la même organisation que l'exemplaire.",
      );
    }
    throw err;
  }
}

export async function listInventoryItems(
  db: DatabaseClient,
  organizationId: string,
): Promise<InventoryItemRecord[]> {
  const rows = await db
    .select()
    .from(inventoryItems)
    .where(
      and(eq(inventoryItems.organizationId, organizationId), isNull(inventoryItems.deletedAt)),
    );
  return rows.map(mapItem);
}

export async function getInventoryItem(
  db: DatabaseClient,
  organizationId: string,
  itemId: string,
): Promise<InventoryItemRecord | null> {
  const [row] = await db
    .select()
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.organizationId, organizationId),
        eq(inventoryItems.id, itemId),
        isNull(inventoryItems.deletedAt),
      ),
    )
    .limit(1);
  return row ? mapItem(row) : null;
}

export async function updateInventoryItem(
  db: DatabaseClient,
  organizationId: string,
  itemId: string,
  input: UpdateInventoryItemInput,
): Promise<InventoryItemRecord> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.serialNumber !== undefined) patch.serialNumber = input.serialNumber;
  if (input.condition !== undefined) patch.condition = input.condition;
  if (input.status !== undefined) patch.status = input.status;
  if (input.notes !== undefined) patch.notes = input.notes;

  const [row] = await db
    .update(inventoryItems)
    .set(patch)
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.organizationId, organizationId)))
    .returning();
  if (!row) throw new AuthorizationError('Exemplaire introuvable.');
  return mapItem(row);
}

/**
 * Transfère un exemplaire vers un nouvel établissement.
 *
 * Transactionnel et idempotent :
 * 1. Recherche la clé d'idempotence D'ABORD (avant tout autre traitement).
 *    - Si la clé existe avec une destination différente → rejet (conflit).
 *    - Si la clé existe avec la même destination → rejeu (retourne le mouvement original).
 * 2. Si from = to (pas de clé existante) → no-op.
 * 3. UPDATE current_location_id + INSERT inventory_movement dans la même transaction.
 *
 * Contrat de rejeu :
 * - `movement` est le mouvement original (inchangé lors d'un rejeu).
 * - `currentItem` est l'état COURANT de l'exemplaire au moment de l'appel,
 *   potentiellement modifié par des transferts ultérieurs.
 *   Ce n'est PAS un snapshot de la réponse initiale : un rejeu après des
 *   transferts intermédiaires retournera le mouvement original accompagné
 *   de l'état courant, pas une reconstitution exacte de la réponse initiale.
 *   Persister un snapshot complet serait excessif pour ce cas d'usage.
 *
 * La cohérence (toLocationId ∈ même org) est vérifiée par le trigger PostgreSQL.
 */
export async function transferInventoryItem(
  db: DatabaseClient,
  input: TransferInventoryItemInput,
): Promise<{ currentItem: InventoryItemRecord; movement: InventoryMovementRecord | null }> {
  return await db.transaction(async (tx) => {
    // Verrouille l'exemplaire et lit sa localisation courante.
    const [item] = await tx
      .select()
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.id, input.inventoryItemId),
          eq(inventoryItems.organizationId, input.organizationId),
          isNull(inventoryItems.deletedAt),
        ),
      )
      .for('update')
      .limit(1);
    if (!item) throw new AuthorizationError('Exemplaire introuvable.');

    const fromLocationId = item.currentLocationId;

    // Idempotence : recherche la clé D'ABORD, avant tout autre traitement.
    // Un retry retourne le mouvement original + l'état courant (cf. JSDoc ci-dessus).
    if (input.idempotencyKey) {
      const [existing] = await tx
        .select()
        .from(inventoryMovements)
        .where(
          and(
            eq(inventoryMovements.inventoryItemId, input.inventoryItemId),
            eq(inventoryMovements.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) {
        // Conflit : la même clé est réutilisée avec une destination différente.
        // On rejette explicitement plutôt que de masquer la nouvelle commande.
        if (existing.toLocationId !== input.toLocationId) {
          throw new CatalogError(
            'CONFLICT_IDEMPOTENCY',
            `Conflit d'idempotence : la clé "${input.idempotencyKey}" existe déjà ` +
              `avec une destination différente.`,
          );
        }
        // Rejeu : retourne le mouvement existant et l'état courant de l'exemplaire.
        return { currentItem: mapItem(item), movement: mapMovement(existing) };
      }
    }

    // No-op : transfert vers la localisation courante (sans clé existante).
    if (fromLocationId === input.toLocationId) {
      return { currentItem: mapItem(item), movement: null };
    }

    // Met à jour la localisation (le trigger vérifie la cohérence d'org).
    let updated: typeof inventoryItems.$inferSelect | undefined;
    try {
      [updated] = await tx
        .update(inventoryItems)
        .set({ currentLocationId: input.toLocationId, updatedAt: new Date() })
        .where(eq(inventoryItems.id, input.inventoryItemId))
        .returning();
    } catch (err) {
      // Trigger check_inventory_org_consistency : cohérence multi-tenant.
      // Message contrôlé (cf. createInventoryItem) : évite de propager err.message brut.
      if (err instanceof Error && err.message.includes('la même organisation')) {
        throw new CatalogError(
          'VALIDATION',
          "L'établissement ou la variante n'appartient pas à la même organisation que l'exemplaire.",
        );
      }
      throw err;
    }
    if (!updated) throw new CatalogError('UNKNOWN', 'Échec du transfert.');

    // Insère le mouvement (append-only).
    const [movement] = await tx
      .insert(inventoryMovements)
      .values({
        inventoryItemId: input.inventoryItemId,
        fromLocationId,
        toLocationId: input.toLocationId,
        reason: input.reason ?? '',
        createdBy: input.createdBy ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning();
    if (!movement) throw new CatalogError('UNKNOWN', "Échec de l'enregistrement du mouvement.");

    return { currentItem: mapItem(updated), movement: mapMovement(movement) };
  });
}

/**
 * Retire un exemplaire du parc (status → RETIRED).
 */
export async function retireInventoryItem(
  db: DatabaseClient,
  organizationId: string,
  itemId: string,
): Promise<InventoryItemRecord> {
  return updateInventoryItem(db, organizationId, itemId, { status: 'RETIRED' });
}

/**
 * Suppression logique d'un exemplaire.
 */
export async function deleteInventoryItem(
  db: DatabaseClient,
  organizationId: string,
  itemId: string,
): Promise<void> {
  await db
    .update(inventoryItems)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.organizationId, organizationId)));
}

function mapItem(row: typeof inventoryItems.$inferSelect): InventoryItemRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    productVariantId: row.productVariantId,
    internalSku: row.internalSku,
    serialNumber: row.serialNumber,
    condition: row.condition as InventoryItemRecord['condition'],
    status: row.status as InventoryItemRecord['status'],
    currentLocationId: row.currentLocationId,
    notes: row.notes,
  };
}

function mapMovement(row: typeof inventoryMovements.$inferSelect): InventoryMovementRecord {
  return {
    id: row.id,
    inventoryItemId: row.inventoryItemId,
    fromLocationId: row.fromLocationId,
    toLocationId: row.toLocationId,
    reason: row.reason,
    createdBy: row.createdBy,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
  };
}
