export type MaintenanceCaseStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';

export interface MaintenanceCaseSummary {
  id: string; // maintenanceCaseId
  maintenanceBlockId: string;
  inventoryItemId: string;
  internalSku: string;
  serialNumber: string | null;
  productName: string;
  variantName: string;
  categorySlug: string;
  locationId: string;
  locationName: string;
  locationTimeZone: string;
  status: MaintenanceCaseStatus;
  condition: string;
  reason: string;
  openedNotes: string | null;
  resolutionNotes: string | null;
  sourceDamageReportId: string | null;
  openedBy: string;
  openedAt: Date;
  startedBy: string | null;
  startedAt: Date | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
}

export interface OpenMaintenanceInput {
  organizationId: string;
  inventoryItemId: string;
  actorUserId: string;
  reason: string;
  notes?: string | null | undefined;
  idempotencyKey: string;
}

export interface OpenMaintenanceResult {
  kind: 'APPLIED';
  maintenanceCaseId: string;
  maintenanceBlockId: string;
  inventoryItemId: string;
}

export interface StartMaintenanceInput {
  organizationId: string;
  maintenanceCaseId: string;
  actorUserId: string;
  idempotencyKey: string;
}

export interface StartMaintenanceResult {
  kind: 'APPLIED';
  maintenanceCaseId: string;
  status: 'IN_PROGRESS';
}

export interface ResolveMaintenanceInput {
  organizationId: string;
  maintenanceCaseId: string; // id du maintenance_case ou maintenanceBlockId
  actorUserId: string;
  targetCondition: 'GOOD' | 'FAIR' | 'NEW';
  notes?: string | null | undefined;
  idempotencyKey: string;
}

export interface ResolveMaintenanceResult {
  kind: 'APPLIED';
  maintenanceCaseId: string;
  maintenanceBlockId: string;
  inventoryItemId: string;
  releasedCondition: string;
}
