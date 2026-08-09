import { conditionReportPhase } from '@uttily/database';
import { INVENTORY_CONDITIONS, type InventoryCondition } from '../catalog/types';

/**
 * @uttily/core — Types partagés pour les rapports d'état et de dommages (G3B).
 *
 * Les enums sont dérivées du schéma Drizzle via `enumValues`. Ces imports sont
 * des descriptions de schéma versionnées : aucune connexion PostgreSQL, aucune
 * variable d'environnement, aucun effet de bord.
 *
 * `InventoryCondition` et `INVENTORY_CONDITIONS` sont réutilisés depuis le module
 * catalog (source de vérité existante) pour éviter une collision d'export au
 * niveau du barrel principal.
 */

export const CONDITION_REPORT_PHASES = conditionReportPhase.enumValues;
export type ConditionReportPhase = (typeof CONDITION_REPORT_PHASES)[number];

/**
 * Entrée commune pour les rapports d'état et de dommages (G3B).
 * inventoryItemId n'est PAS demandé au client : il est dérivé du booking_item
 * verrouillé dans la transaction.
 */
export interface ReportInput {
  organizationId: string;
  bookingId: string;
  bookingItemId: string;
  actorUserId: string;
  idempotencyKey: string;
}

export interface ConditionReportInput extends ReportInput {
  phase: ConditionReportPhase;
  condition: InventoryCondition;
  notes?: string | null;
}

export interface DamageReportInput extends ReportInput {
  description: string;
}

/**
 * Résultat rejouable d'un rapport d'état.
 */
export interface ConditionReportResult {
  kind: 'APPLIED';
  reportId: string;
  bookingId: string;
  bookingItemId: string;
  inventoryItemId: string;
  phase: ConditionReportPhase;
  condition: InventoryCondition;
}

/**
 * Résultat rejouable d'une déclaration de dommage.
 */
export interface DamageReportResult {
  kind: 'APPLIED';
  reportId: string;
  bookingId: string;
  bookingItemId: string;
  inventoryItemId: string;
}

/**
 * Type guard : vérifie qu'une valeur est un ConditionReportPhase valide.
 */
export function isConditionReportPhase(value: unknown): value is ConditionReportPhase {
  return (
    typeof value === 'string' && (CONDITION_REPORT_PHASES as readonly string[]).includes(value)
  );
}

/**
 * Type guard : vérifie qu'une valeur est un InventoryCondition valide.
 * Utilise INVENTORY_CONDITIONS du module catalog (source de vérité).
 */
export function isInventoryCondition(value: unknown): value is InventoryCondition {
  return typeof value === 'string' && (INVENTORY_CONDITIONS as readonly string[]).includes(value);
}
