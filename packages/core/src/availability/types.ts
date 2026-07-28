export const INVENTORY_BLOCK_TYPES = ['HOLD', 'BOOKING', 'MAINTENANCE', 'MANUAL_BLOCK'] as const;
export type InventoryBlockType = (typeof INVENTORY_BLOCK_TYPES)[number];

export const INVENTORY_BLOCK_STATUSES = [
  'ACTIVE',
  'PAYMENT_PROCESSING',
  'CONVERTED',
  'RELEASED',
  'EXPIRED',
] as const;
export type InventoryBlockStatus = (typeof INVENTORY_BLOCK_STATUSES)[number];

export interface InventoryBlockRecord {
  id: string;
  organizationId: string;
  inventoryItemId: string;
  type: InventoryBlockType;
  status: InventoryBlockStatus;
  customerStartAt: Date;
  customerEndAt: Date;
  blockedStartAt: Date;
  blockedEndAt: Date;
  expiresAt: Date | null;
  sourceId: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CreateInventoryBlockInput {
  organizationId: string;
  inventoryItemId: string;
  type: InventoryBlockType;
  customerStartAt: Date;
  customerEndAt: Date;
  blockedStartAt: Date;
  blockedEndAt: Date;
  expiresAt?: Date;
  sourceId?: string;
  createdBy?: string;
}

export interface AvailableItemSummary {
  id: string;
  organizationId: string;
  productVariantId: string;
  internalSku: string;
  condition: string;
  status: string;
  currentLocationId: string;
}
