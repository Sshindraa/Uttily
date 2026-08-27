export type BookingStatus =
  | 'CONFIRMED'
  | 'READY_FOR_PICKUP'
  | 'ACTIVE'
  | 'RETURNED'
  | 'CLOSED'
  | 'CANCELLED'
  | 'REFUNDED';

export const BOOKING_STATUSES: readonly BookingStatus[] = [
  'CONFIRMED',
  'READY_FOR_PICKUP',
  'ACTIVE',
  'RETURNED',
  'CLOSED',
  'CANCELLED',
  'REFUNDED',
] as const;

export type InventoryCondition = 'NEW' | 'GOOD' | 'FAIR' | 'POOR' | 'BROKEN';
export type ConditionReportPhase = 'PICKUP' | 'RETURN';
export type FulfillmentEventType = 'PREPARED' | 'PICKED_UP' | 'RETURNED' | 'CLOSED';

/**
 * Helpers purs pour l'interface des opérations terrain (G4B).
 * Aucune dépendance React ou Next.js — testables isolément.
 */

/**
 * Mappe un statut de booking vers un libellé explicite en français.
 */
export function bookingStatusLabel(status: BookingStatus): string {
  switch (status) {
    case 'CONFIRMED':
      return 'Confirmée';
    case 'READY_FOR_PICKUP':
      return 'Prête au retrait';
    case 'ACTIVE':
      return 'En cours';
    case 'RETURNED':
      return 'À réceptionner';
    case 'CLOSED':
      return 'Clôturée';
    case 'CANCELLED':
      return 'Annulée';
    case 'REFUNDED':
      return 'Remboursée';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/**
 * Détermine l'action de transition autorisée pour un statut donné.
 * Retourne null pour les statuts terminaux (aucune action).
 */
export type TransitionActionKind = 'prepare' | 'pickup' | 'return' | 'close';

export interface TransitionActionInfo {
  kind: TransitionActionKind;
  label: string;
  helpText: string;
}

export function getTransitionAction(status: BookingStatus): TransitionActionInfo | null {
  switch (status) {
    case 'CONFIRMED':
      return {
        kind: 'prepare',
        label: 'Marquer comme préparée',
        helpText: 'Confirme que le matériel est prêt pour le retrait par le client.',
      };
    case 'READY_FOR_PICKUP':
      return {
        kind: 'pickup',
        label: 'Confirmer la remise au client',
        helpText: 'Confirme que le matériel a été remis au client. Cette action est irréversible.',
      };
    case 'ACTIVE':
      return {
        kind: 'return',
        label: 'Confirmer la réception du matériel',
        helpText:
          'Confirme que le matériel a été retourné par le client. Cette action est irréversible.',
      };
    case 'RETURNED':
      return {
        kind: 'close',
        label: 'Clôturer la réservation',
        helpText:
          'Clôture la réservation après vérification du matériel retourné. Cette action est irréversible.',
      };
    case 'CLOSED':
    case 'CANCELLED':
    case 'REFUNDED':
      return null;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/**
 * Détermine si un rapport d'état PICKUP est autorisé pour ce statut.
 */
export function canCreatePickupReport(status: BookingStatus): boolean {
  return status === 'READY_FOR_PICKUP';
}

/**
 * Détermine si un rapport d'état RETURN est autorisé pour ce statut.
 */
export function canCreateReturnReport(status: BookingStatus): boolean {
  return status === 'ACTIVE';
}

/**
 * Détermine si une déclaration de dommage est autorisée pour ce statut.
 */
export function canCreateDamageReport(status: BookingStatus): boolean {
  return status === 'ACTIVE' || status === 'RETURNED';
}

/**
 * Détermine si la réservation est en lecture seule (statut terminal).
 */
export function isReadOnlyStatus(status: BookingStatus): boolean {
  return status === 'CLOSED' || status === 'CANCELLED' || status === 'REFUNDED';
}

/**
 * Filtres rapides pour la liste des opérations.
 * Chaque filtre est un ensemble de statuts à afficher.
 */
export interface QuickFilter {
  key: string;
  label: string;
  statuses: readonly BookingStatus[];
}

export const QUICK_FILTERS: readonly QuickFilter[] = [
  { key: 'all', label: 'Toutes', statuses: BOOKING_STATUSES },
  { key: 'to_prepare', label: 'À préparer', statuses: ['CONFIRMED'] },
  { key: 'ready', label: 'Prêtes au retrait', statuses: ['READY_FOR_PICKUP'] },
  { key: 'active', label: 'En cours', statuses: ['ACTIVE'] },
  { key: 'to_return', label: 'À réceptionner', statuses: ['RETURNED'] },
  { key: 'closed', label: 'Clôturées', statuses: ['CLOSED', 'CANCELLED', 'REFUNDED'] },
];

/**
 * Construit l'URL d'un filtre rapide avec des paramètres répétés.
 * Utilise URLSearchParams pour produire `?status=CLOSED&status=CANCELLED&status=REFUNDED`
 * (et non `?status=CLOSED,CANCELLED,REFUNDED` qui casse parseStatusFilter).
 * Le filtre 'all' retourne l'URL sans query string.
 */
export function buildFilterUrl(orgId: string, filter: QuickFilter): string {
  const base = `/dashboard/${orgId}/operations`;
  if (filter.key === 'all' || filter.statuses.length === 0) return base;
  const params = new URLSearchParams();
  for (const status of filter.statuses) {
    params.append('status', status);
  }
  return `${base}?${params.toString()}`;
}

/**
 * Valide le paramètre searchParams `status` contre BOOKING_STATUSES.
 * Retourne un tableau de statuts validés et dédupliqués, ou null si le paramètre est absent.
 * Lève une erreur si une valeur est invalide (pour affichage d'erreur).
 */
export function parseStatusFilter(
  statusParam: string | string[] | undefined,
): BookingStatus[] | null {
  if (statusParam === undefined || statusParam === '') return null;
  const values = Array.isArray(statusParam) ? statusParam : [statusParam];
  const seen = new Set<BookingStatus>();
  for (const v of values) {
    if (typeof v !== 'string') continue;
    if (!(BOOKING_STATUSES as readonly string[]).includes(v)) {
      throw new Error(`Statut invalide: ${v}`);
    }
    seen.add(v as BookingStatus);
  }
  return [...seen];
}

/**
 * Formate une date dans un fuseau IANA déterministe.
 * Utilise Intl.DateTimeFormat avec le fuseau du lieu.
 */
export function formatDateTimeInTimeZone(
  date: Date,
  timeZone: string,
  options?: {
    dateStyle?: 'full' | 'long' | 'medium' | 'short';
    timeStyle?: 'full' | 'long' | 'medium' | 'short';
  },
): string {
  const opts = {
    dateStyle: options?.dateStyle ?? 'long',
    timeStyle: options?.timeStyle ?? 'short',
    timeZone,
  };
  try {
    return new Intl.DateTimeFormat('fr-FR', opts).format(date);
  } catch {
    // Fallback si le fuseau est invalide (ne devrait pas arriver avec les données DB).
    return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' }).format(date);
  }
}

/**
 * Valide qu'une chaîne est un UUID valide.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

/**
 * Libellés pour les conditions d'inventaire.
 */
export function conditionLabel(condition: InventoryCondition): string {
  switch (condition) {
    case 'NEW':
      return 'Neuf';
    case 'GOOD':
      return 'Bon';
    case 'FAIR':
      return 'Correct';
    case 'POOR':
      return 'Médiocre';
    case 'BROKEN':
      return 'Cassé';
    default: {
      const _exhaustive: never = condition;
      return _exhaustive;
    }
  }
}

/**
 * Libellés pour les phases de rapport.
 */
export function phaseLabel(phase: ConditionReportPhase): string {
  switch (phase) {
    case 'PICKUP':
      return 'Retrait';
    case 'RETURN':
      return 'Retour';
    default: {
      const _exhaustive: never = phase;
      return _exhaustive;
    }
  }
}

/**
 * Libellés pour les types d'événements de fulfillment.
 */
export function eventTypeLabel(eventType: FulfillmentEventType): string {
  switch (eventType) {
    case 'PREPARED':
      return 'Préparation';
    case 'PICKED_UP':
      return 'Retrait';
    case 'RETURNED':
      return 'Retour';
    case 'CLOSED':
      return 'Clôture';
    default: {
      const _exhaustive: never = eventType;
      return _exhaustive;
    }
  }
}
