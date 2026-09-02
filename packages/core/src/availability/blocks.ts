import { and, eq, isNull } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { inventoryBlocks, inventoryItems } from '@uttily/database';
import type {
  InventoryBlockRecord,
  InventoryBlockStatus,
  InventoryBlockType,
  CreateInventoryBlockInput,
} from './types';
import { CatalogError } from '../catalog/errors';
import { AuthorizationError } from '../identity/permissions';

/**
 * Représentation minimale d'une erreur PostgreSQL levée par le driver.
 * Le code '23P01' correspond à une exclusion_violation (contrainte EXCLUDE).
 */
interface PostgresError {
  code?: string;
  constraint_name?: string;
  constraint?: string;
}

/**
 * Vérifie qu'une erreur est une violation de contrainte d'exclusion PostgreSQL
 * (SQLSTATE 23P01) sur la contrainte nommée. Permet de catcher les conflits
 * de chevauchement par nom de contrainte plutôt que par analyse du message.
 */
function isExclusionViolation(err: unknown, constraintName: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const pgErr = err as PostgresError;
  return (
    pgErr.code === '23P01' &&
    (pgErr.constraint_name === constraintName || pgErr.constraint === constraintName)
  );
}

/**
 * Crée un blocage de disponibilité pour un exemplaire.
 *
 * Valide que la période bloquée inclut la période client
 * (blockedStartAt <= customerStartAt ET blockedEndAt >= customerEndAt).
 *
 * La contrainte d'exclusion PostgreSQL (no_overlapping_blocks) empêche
 * le chevauchement de blocs ACTIVE/PAYMENT_PROCESSING pour un même exemplaire.
 * Une violation de cette contrainte est catchée et levée comme CONFLICT_BLOCK.
 */
export async function createInventoryBlock(
  db: DatabaseClient,
  input: CreateInventoryBlockInput,
): Promise<InventoryBlockRecord> {
  // Validation : les périodes doivent être valides (fin > début).
  if (input.blockedEndAt <= input.blockedStartAt) {
    throw new CatalogError(
      'VALIDATION',
      'La date de fin de blocage doit être après la date de début.',
    );
  }
  if (input.customerEndAt <= input.customerStartAt) {
    throw new CatalogError(
      'VALIDATION',
      'La date de fin client doit être après la date de début client.',
    );
  }

  // Validation : les dates fournies ne doivent pas être des Invalid Date.
  if (
    !Number.isFinite(input.blockedStartAt.getTime()) ||
    !Number.isFinite(input.blockedEndAt.getTime()) ||
    !Number.isFinite(input.customerStartAt.getTime()) ||
    !Number.isFinite(input.customerEndAt.getTime())
  ) {
    throw new CatalogError('VALIDATION', 'Les dates fournies sont invalides.');
  }

  // Validation : expiresAt (lorsqu'il est fourni) ne doit pas être une Invalid Date.
  if (input.expiresAt && !Number.isFinite(input.expiresAt.getTime())) {
    throw new CatalogError('VALIDATION', "La date d'expiration est invalide.");
  }

  // Validation : la période bloquée doit inclure la période client.
  if (input.blockedStartAt > input.customerStartAt) {
    const msg = 'La date de début de blocage doit précéder ou égaler la date de début client.';
    throw new CatalogError('VALIDATION', msg, { blockedStartAt: msg });
  }
  if (input.blockedEndAt < input.customerEndAt) {
    const msg = 'La date de fin de blocage doit suivre ou égaler la date de fin client.';
    throw new CatalogError('VALIDATION', msg, { blockedEndAt: msg });
  }

  // Invariant : expires_at est obligatoire pour HOLD, interdit pour les autres types.
  if (input.type === 'HOLD' && !input.expiresAt) {
    throw new CatalogError('VALIDATION', "Un hold doit avoir une date d'expiration.");
  }
  if (input.type !== 'HOLD' && input.expiresAt) {
    throw new CatalogError('VALIDATION', "Seuls les holds peuvent avoir une date d'expiration.");
  }

  // Validation : l'exemplaire doit appartenir à la même organisation.
  const [item] = await db
    .select({ organizationId: inventoryItems.organizationId })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, input.inventoryItemId), isNull(inventoryItems.deletedAt)))
    .limit(1);
  if (!item || item.organizationId !== input.organizationId) {
    throw new AuthorizationError('Exemplaire introuvable dans cette organisation.');
  }

  try {
    const [row] = await db
      .insert(inventoryBlocks)
      .values({
        organizationId: input.organizationId,
        inventoryItemId: input.inventoryItemId,
        type: input.type,
        customerStartAt: input.customerStartAt,
        customerEndAt: input.customerEndAt,
        blockedStartAt: input.blockedStartAt,
        blockedEndAt: input.blockedEndAt,
        expiresAt: input.expiresAt ?? null,
        sourceId: input.sourceId ?? null,
        createdBy: input.createdBy ?? null,
      })
      .returning();
    if (!row) throw new CatalogError('UNKNOWN', 'Échec de création du blocage.');
    return mapBlock(row);
  } catch (err) {
    // Conflit de chevauchement : violation de la contrainte d'exclusion.
    if (isExclusionViolation(err, 'no_overlapping_blocks')) {
      const msg = 'Un blocage actif existe déjà sur cette période pour cet exemplaire.';
      throw new CatalogError('CONFLICT_BLOCK', msg);
    }
    throw err;
  }
}

/**
 * Lit un blocage par son ID, filtré par organisation (isolation multi-tenant).
 */
export async function getInventoryBlock(
  db: DatabaseClient,
  organizationId: string,
  blockId: string,
): Promise<InventoryBlockRecord | null> {
  const [row] = await db
    .select()
    .from(inventoryBlocks)
    .where(
      and(
        eq(inventoryBlocks.id, blockId),
        eq(inventoryBlocks.organizationId, organizationId),
        isNull(inventoryBlocks.deletedAt),
      ),
    )
    .limit(1);
  return row ? mapBlock(row) : null;
}

/**
 * Liste les blocages d'un exemplaire, filtré par organisation.
 * Vérifie l'appartenance de l'exemplaire à l'organisation.
 */
export async function listBlocksForItem(
  db: DatabaseClient,
  organizationId: string,
  inventoryItemId: string,
): Promise<InventoryBlockRecord[]> {
  // Vérifie que l'exemplaire appartient à l'organisation.
  const [item] = await db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.id, inventoryItemId),
        eq(inventoryItems.organizationId, organizationId),
        isNull(inventoryItems.deletedAt),
      ),
    )
    .limit(1);
  if (!item) return [];

  const rows = await db
    .select()
    .from(inventoryBlocks)
    .where(
      and(
        eq(inventoryBlocks.inventoryItemId, inventoryItemId),
        eq(inventoryBlocks.organizationId, organizationId),
        isNull(inventoryBlocks.deletedAt),
      ),
    );
  return rows.map(mapBlock);
}

/**
 * Libère un blocage (statut → RELEASED).
 * Transactionnelle avec FOR UPDATE : valide que le statut actuel est ACTIVE
 * ou PAYMENT_PROCESSING (libération volontaire).
 */
export async function releaseBlock(
  db: DatabaseClient,
  organizationId: string,
  blockId: string,
  expectedType?: InventoryBlockType,
): Promise<InventoryBlockRecord> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(inventoryBlocks)
      .where(
        and(
          eq(inventoryBlocks.id, blockId),
          eq(inventoryBlocks.organizationId, organizationId),
          isNull(inventoryBlocks.deletedAt),
        ),
      )
      .for('update')
      .limit(1);
    if (!row) throw new CatalogError('BLOCK_NOT_FOUND', 'Blocage introuvable.');
    if (expectedType !== undefined && row.type !== expectedType) {
      throw new CatalogError(
        'BLOCK_INVALID_TRANSITION',
        `Seul un blocage de type ${expectedType} peut être libéré par cette action.`,
      );
    }
    if (row.status !== 'ACTIVE' && row.status !== 'PAYMENT_PROCESSING') {
      const msg = `Transition invalide : un blocage ${row.status} ne peut pas être libéré.`;
      throw new CatalogError('BLOCK_INVALID_TRANSITION', msg);
    }
    const [updated] = await tx
      .update(inventoryBlocks)
      .set({ status: 'RELEASED', updatedAt: new Date() })
      .where(eq(inventoryBlocks.id, blockId))
      .returning();
    if (!updated) throw new CatalogError('BLOCK_NOT_FOUND', 'Blocage introuvable.');
    return mapBlock(updated);
  });
}

/**
 * Expire un blocage (statut → EXPIRED).
 * Transactionnelle avec FOR UPDATE. N'accepte que ACTIVE (pas PAYMENT_PROCESSING) :
 * un hold dont le paiement est en traitement ne doit pas être expiré aveuglément,
 * le worker doit d'abord vérifier l'état réel du paiement (doc ligne 53).
 * Valide que expiresAt est dans le passé.
 */
export async function expireBlock(
  db: DatabaseClient,
  organizationId: string,
  blockId: string,
): Promise<InventoryBlockRecord> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(inventoryBlocks)
      .where(
        and(
          eq(inventoryBlocks.id, blockId),
          eq(inventoryBlocks.organizationId, organizationId),
          isNull(inventoryBlocks.deletedAt),
        ),
      )
      .for('update')
      .limit(1);
    if (!row) throw new CatalogError('BLOCK_NOT_FOUND', 'Blocage introuvable.');
    // Un hold PAYMENT_PROCESSING ne doit pas être expiré aveuglément :
    // le worker doit d'abord vérifier l'état réel du paiement (doc ligne 53).
    if (row.status !== 'ACTIVE') {
      const msg = `Transition invalide : un blocage ${row.status} ne peut pas être expiré.`;
      throw new CatalogError('BLOCK_INVALID_TRANSITION', msg);
    }
    if (!row.expiresAt || row.expiresAt > new Date()) {
      const msg = "Le blocage n'est pas encore expiré (expiresAt dans le futur ou non défini).";
      throw new CatalogError('BLOCK_INVALID_TRANSITION', msg);
    }
    const [updated] = await tx
      .update(inventoryBlocks)
      .set({ status: 'EXPIRED', updatedAt: new Date() })
      .where(eq(inventoryBlocks.id, blockId))
      .returning();
    if (!updated) throw new CatalogError('BLOCK_NOT_FOUND', 'Blocage introuvable.');
    return mapBlock(updated);
  });
}

/**
 * Convertit un hold en booking : passe le statut du bloc source à CONVERTED
 * et crée un nouveau bloc de type BOOKING sur la même période.
 * Transactionnel : les deux opérations réussissent ou échouent ensemble.
 * Valide que le bloc source est ACTIVE ou PAYMENT_PROCESSING et de type HOLD.
 */
export async function convertBlock(
  db: DatabaseClient,
  organizationId: string,
  blockId: string,
  newType: InventoryBlockType,
): Promise<InventoryBlockRecord> {
  return await db.transaction(async (tx) => {
    // Verrouille le bloc source pour la conversion.
    const [source] = await tx
      .select()
      .from(inventoryBlocks)
      .where(
        and(
          eq(inventoryBlocks.id, blockId),
          eq(inventoryBlocks.organizationId, organizationId),
          isNull(inventoryBlocks.deletedAt),
        ),
      )
      .for('update')
      .limit(1);
    if (!source) {
      throw new CatalogError('BLOCK_NOT_FOUND', 'Blocage introuvable.');
    }

    const sourceStatus = source.status as InventoryBlockStatus;
    const sourceType = source.type as InventoryBlockType;

    if (sourceType !== 'HOLD') {
      const msg = `Transition invalide : seul un hold peut être converti (type actuel: ${sourceType}).`;
      throw new CatalogError('BLOCK_INVALID_TRANSITION', msg);
    }
    if (newType !== 'BOOKING') {
      throw new CatalogError('VALIDATION', 'Seule la conversion vers BOOKING est autorisée.');
    }
    if (sourceStatus !== 'ACTIVE' && sourceStatus !== 'PAYMENT_PROCESSING') {
      const msg = `Transition invalide : un blocage ${sourceStatus} ne peut pas être converti.`;
      throw new CatalogError('BLOCK_INVALID_TRANSITION', msg);
    }

    // Marque le bloc source comme CONVERTED (ne bloque plus).
    const [updated] = await tx
      .update(inventoryBlocks)
      .set({ status: 'CONVERTED', updatedAt: new Date() })
      .where(eq(inventoryBlocks.id, blockId))
      .returning();

    // Crée le nouveau bloc BOOKING sur la même période.
    // Le bloc CONVERTED ne bloque plus (hors du WHERE de la contrainte d'exclusion),
    // donc le nouveau bloc peut être inséré sans conflit.
    const [created] = await tx
      .insert(inventoryBlocks)
      .values({
        organizationId: source.organizationId,
        inventoryItemId: source.inventoryItemId,
        type: newType,
        customerStartAt: source.customerStartAt,
        customerEndAt: source.customerEndAt,
        blockedStartAt: source.blockedStartAt,
        blockedEndAt: source.blockedEndAt,
        sourceId: source.id,
        createdBy: source.createdBy,
      })
      .returning();

    if (!updated || !created) {
      throw new CatalogError('UNKNOWN', 'Échec de la conversion du blocage.');
    }
    return mapBlock(created);
  });
}

function mapBlock(row: typeof inventoryBlocks.$inferSelect): InventoryBlockRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    inventoryItemId: row.inventoryItemId,
    type: row.type as InventoryBlockType,
    status: row.status as InventoryBlockStatus,
    customerStartAt: row.customerStartAt,
    customerEndAt: row.customerEndAt,
    blockedStartAt: row.blockedStartAt,
    blockedEndAt: row.blockedEndAt,
    expiresAt: row.expiresAt,
    sourceId: row.sourceId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}
