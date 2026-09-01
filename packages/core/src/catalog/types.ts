import { inventoryCondition } from '@uttily/database';
import type { PhotoSlotType } from '@uttily/contracts';

export const PUBLICATION_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

/**
 * Conditions d'inventaire dérivées de l'enum Drizzle `inventoryCondition.enumValues`.
 * Source de vérité unique : packages/database/src/schema.ts. Cet import est une
 * description de schéma versionnée : aucune connexion PostgreSQL, aucune
 * variable d'environnement, aucun effet de bord.
 */
export const INVENTORY_CONDITIONS = inventoryCondition.enumValues;
export type InventoryCondition = (typeof INVENTORY_CONDITIONS)[number];

export const INVENTORY_STATUSES = ['ACTIVE', 'RETIRED', 'LOST'] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

export interface CategoryRecord {
  id: string;
  parentId: string | null;
  slug: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

export interface ProductRecord {
  id: string;
  organizationId: string;
  categoryId: string;
  name: string;
  slug: string;
  description: string;
  publicationStatus: PublicationStatus;
}

export interface ProductVariantRecord {
  id: string;
  productId: string;
  name: string;
  skuSuffix: string | null;
  attributes: Record<string, unknown>;
  isActive: boolean;
}

export interface InventoryItemRecord {
  id: string;
  organizationId: string;
  productVariantId: string;
  internalSku: string;
  serialNumber: string | null;
  condition: InventoryCondition;
  status: InventoryStatus;
  currentLocationId: string;
  notes: string | null;
}

export interface InventoryMovementRecord {
  id: string;
  inventoryItemId: string;
  fromLocationId: string | null;
  toLocationId: string | null;
  reason: string;
  createdBy: string | null;
  idempotencyKey: string | null;
  createdAt: Date;
}

export interface CreateCategoryInput {
  parentId?: string;
  slug: string;
  name: string;
  description?: string;
}

export interface UpdateCategoryInput {
  name?: string;
  description?: string;
}

export interface CreateProductInput {
  organizationId: string;
  categoryId: string;
  name: string;
  slug?: string;
  description?: string;
}

export interface UpdateProductInput {
  name?: string;
  categoryId?: string;
  description?: string;
  slug?: string;
}

export interface CreateVariantInput {
  organizationId: string;
  productId: string;
  name: string;
  skuSuffix?: string;
  attributes?: Record<string, unknown>;
}

export interface UpdateVariantInput {
  name?: string;
  skuSuffix?: string | null;
  attributes?: Record<string, unknown>;
}

export interface CreateInventoryItemInput {
  organizationId: string;
  productVariantId: string;
  internalSku: string;
  serialNumber?: string;
  condition?: InventoryCondition;
  status?: InventoryStatus;
  currentLocationId: string;
  notes?: string;
}

export interface UpdateInventoryItemInput {
  serialNumber?: string | null;
  condition?: InventoryCondition;
  status?: InventoryStatus;
  notes?: string | null;
}

export interface TransferInventoryItemInput {
  organizationId: string;
  inventoryItemId: string;
  toLocationId: string;
  reason?: string;
  idempotencyKey?: string;
  createdBy?: string;
}

// ---------------------------------------------------------------------------
// Read models (vues agrégées pour l'affichage côté UI/API).
// ---------------------------------------------------------------------------

export interface ProductSummary {
  id: string;
  name: string;
  slug: string;
  publicationStatus: PublicationStatus;
  categoryId: string;
  categoryName: string;
  activeVariantCount: number;
  activeInventoryCount: number;
}

export interface PublicationReadiness {
  ready: boolean;
  failures: string[];
}

export interface ProductPhotoSummary {
  id: string;
  publicId: string;
  slotType: PhotoSlotType | null;
  fileState: 'PENDING_UPLOAD' | 'AVAILABLE' | 'REJECTED' | 'DELETED';
  contentType: string | null;
  byteSize: number | null;
  widthPx: number | null;
  heightPx: number | null;
  sortOrder: number;
  rejectionReason: string | null;
}

export interface ProductDetails {
  product: ProductRecord;
  category: { id: string; name: string; isActive: boolean };
  variants: ProductVariantRecord[];
  photos: ProductPhotoSummary[];
  activeVariantCount: number;
  activeInventoryCount: number;
  publicationReadiness: PublicationReadiness;
}

export interface InventorySummary {
  id: string;
  internalSku: string;
  serialNumber: string | null;
  condition: InventoryCondition;
  status: InventoryStatus;
  productVariantId: string;
  variantName: string;
  productId: string;
  productName: string;
  categorySlug: string;
  currentLocationId: string;
  locationName: string;
}

export interface InventoryDetails {
  item: InventoryItemRecord;
  variant: { id: string; name: string; productId: string };
  product: { id: string; name: string };
  location: { id: string; name: string };
  movements: InventoryMovementRecord[];
}

export interface ActiveVariantOption {
  id: string;
  name: string;
  productId: string;
  productName: string;
}
