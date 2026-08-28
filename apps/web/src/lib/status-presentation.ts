import type {
  BookingStatus,
  InventoryCondition,
  InventoryStatus,
  PaymentStatus,
  RefundStatus,
} from '@uttily/contracts';

/**
 * Présentation visuelle unifiée des statuts métier Uttily (Chantier 17).
 *
 * Règles :
 * - Un libellé français clair et humain pour chaque statut
 * - Aucune exposition brute d'identifiants techniques ou enums SQL
 * - Couleurs et hiérarchie visuelle homogènes
 * - Fonction pure, client-safe et testable isolément
 */

export interface StatusBadgeDescriptor {
  label: string;
  badgeStyle: {
    backgroundColor: string;
    color: string;
    borderColor: string;
  };
  icon?: string;
}

// ---------------------------------------------------------------------------
// 1. Statuts de Réservation
// ---------------------------------------------------------------------------

export function getBookingStatusPresentation(status: BookingStatus): StatusBadgeDescriptor {
  switch (status) {
    case 'CONFIRMED':
      return {
        label: 'Confirmée · À préparer',
        badgeStyle: {
          backgroundColor: '#eff6ff',
          color: '#1d4ed8',
          borderColor: '#bfdbfe',
        },
        icon: '✓',
      };
    case 'READY_FOR_PICKUP':
      return {
        label: 'Prête au retrait',
        badgeStyle: {
          backgroundColor: '#ecfdf5',
          color: '#047857',
          borderColor: '#a7f3d0',
        },
        icon: '🟢',
      };
    case 'ACTIVE':
      return {
        label: 'Location en cours',
        badgeStyle: {
          backgroundColor: '#f0fdf4',
          color: '#15803d',
          borderColor: '#bbf7d0',
        },
        icon: '🚲',
      };
    case 'RETURNED':
      return {
        label: 'Vélo restitué · À réceptionner',
        badgeStyle: {
          backgroundColor: '#fefce8',
          color: '#854d0e',
          borderColor: '#fef08a',
        },
        icon: '🔍',
      };
    case 'CLOSED':
      return {
        label: 'Dossier clôturé',
        badgeStyle: {
          backgroundColor: '#f8fafc',
          color: '#475569',
          borderColor: '#e2e8f0',
        },
        icon: '🏁',
      };
    case 'CANCELLED':
      return {
        label: 'Annulée',
        badgeStyle: {
          backgroundColor: '#fef2f2',
          color: '#b91c1c',
          borderColor: '#fecaca',
        },
        icon: '✕',
      };
    case 'REFUNDED':
      return {
        label: 'Annulée · Remboursée',
        badgeStyle: {
          backgroundColor: '#f8fafc',
          color: '#64748b',
          borderColor: '#e2e8f0',
        },
        icon: '↩',
      };
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// 2. État physique du matériel (Condition)
// ---------------------------------------------------------------------------

export function getInventoryConditionPresentation(
  condition: InventoryCondition,
): StatusBadgeDescriptor {
  switch (condition) {
    case 'NEW':
      return {
        label: 'Neuf',
        badgeStyle: {
          backgroundColor: '#f0fdf4',
          color: '#166534',
          borderColor: '#bbf7d0',
        },
      };
    case 'GOOD':
      return {
        label: 'Bon état',
        badgeStyle: {
          backgroundColor: '#f0fdf4',
          color: '#15803d',
          borderColor: '#bbf7d0',
        },
      };
    case 'FAIR':
      return {
        label: 'État correct',
        badgeStyle: {
          backgroundColor: '#fefce8',
          color: '#854d0e',
          borderColor: '#fef08a',
        },
      };
    case 'POOR':
      return {
        label: 'Usagé',
        badgeStyle: {
          backgroundColor: '#fff7ed',
          color: '#9a3412',
          borderColor: '#fed7aa',
        },
      };
    case 'BROKEN':
      return {
        label: 'En réparation / Hors service',
        badgeStyle: {
          backgroundColor: '#fef2f2',
          color: '#991b1b',
          borderColor: '#fecaca',
        },
      };
    default: {
      const _exhaustive: never = condition;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Statut du parc / flotte (Inventory status)
// ---------------------------------------------------------------------------

export function getInventoryStatusPresentation(
  status: InventoryStatus,
  isBroken = false,
): StatusBadgeDescriptor {
  if (isBroken) {
    return {
      label: 'En maintenance',
      badgeStyle: {
        backgroundColor: '#fff7ed',
        color: '#c2410c',
        borderColor: '#ffedd5',
      },
      icon: '🔧',
    };
  }

  switch (status) {
    case 'ACTIVE':
      return {
        label: 'En service · Disponible',
        badgeStyle: {
          backgroundColor: '#f0fdf4',
          color: '#166534',
          borderColor: '#dcfce7',
        },
        icon: '🟢',
      };
    case 'RETIRED':
      return {
        label: 'Retiré du parc',
        badgeStyle: {
          backgroundColor: '#f1f5f9',
          color: '#475569',
          borderColor: '#e2e8f0',
        },
        icon: '⚫',
      };
    case 'LOST':
      return {
        label: 'Déclaré perdu / volé',
        badgeStyle: {
          backgroundColor: '#fef2f2',
          color: '#991b1b',
          borderColor: '#fecaca',
        },
        icon: '⚠️',
      };
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Synthèse de publication d'un vélo (Cockpit Pro)
// ---------------------------------------------------------------------------

export type UnifiedBikeStatusSummary =
  'ONLINE_AVAILABLE' | 'ONLINE_UNAVAILABLE' | 'READY_TO_PUBLISH' | 'INCOMPLETE' | 'ARCHIVED';

export function getBikeStatusSummaryPresentation(
  statusSummary: UnifiedBikeStatusSummary,
): StatusBadgeDescriptor {
  switch (statusSummary) {
    case 'ONLINE_AVAILABLE':
      return {
        label: 'En ligne · Réservable',
        badgeStyle: {
          backgroundColor: '#ecfdf5',
          color: '#065f46',
          borderColor: '#a7f3d0',
        },
        icon: '🟢',
      };
    case 'ONLINE_UNAVAILABLE':
      return {
        label: 'En ligne · Indisponible',
        badgeStyle: {
          backgroundColor: '#fef2f2',
          color: '#dc2626',
          borderColor: '#fca5a5',
        },
        icon: '🔴',
      };
    case 'READY_TO_PUBLISH':
      return {
        label: 'Prêt à publier',
        badgeStyle: {
          backgroundColor: '#eff6ff',
          color: '#1d4ed8',
          borderColor: '#bfdbfe',
        },
        icon: '🔵',
      };
    case 'INCOMPLETE':
      return {
        label: 'Configuration incomplète',
        badgeStyle: {
          backgroundColor: '#f8fafc',
          color: '#475569',
          borderColor: '#e2e8f0',
        },
        icon: '⚪',
      };
    case 'ARCHIVED':
      return {
        label: 'Archivé',
        badgeStyle: {
          backgroundColor: '#f1f5f9',
          color: '#64748b',
          borderColor: '#cbd5e1',
        },
        icon: '⚫',
      };
    default: {
      const _exhaustive: never = statusSummary;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Statuts de paiement et remboursement
// ---------------------------------------------------------------------------

export function getPaymentStatusPresentation(status: PaymentStatus): StatusBadgeDescriptor {
  switch (status) {
    case 'SUCCEEDED':
      return {
        label: 'Payé',
        badgeStyle: {
          backgroundColor: '#ecfdf5',
          color: '#047857',
          borderColor: '#a7f3d0',
        },
        icon: '✓',
      };
    case 'PENDING_PROVIDER':
    case 'PROCESSING':
      return {
        label: 'Paiement en cours',
        badgeStyle: {
          backgroundColor: '#eff6ff',
          color: '#1d4ed8',
          borderColor: '#bfdbfe',
        },
        icon: '⏳',
      };
    case 'REQUIRES_PAYMENT_METHOD':
    case 'REQUIRES_ACTION':
      return {
        label: 'Action de paiement requise',
        badgeStyle: {
          backgroundColor: '#fffbeb',
          color: '#b45309',
          borderColor: '#fde68a',
        },
        icon: '⚠️',
      };
    case 'FAILED':
      return {
        label: 'Paiement échoué',
        badgeStyle: {
          backgroundColor: '#fef2f2',
          color: '#b91c1c',
          borderColor: '#fecaca',
        },
        icon: '✕',
      };
    case 'CANCELLED':
      return {
        label: 'Paiement annulé',
        badgeStyle: {
          backgroundColor: '#f8fafc',
          color: '#64748b',
          borderColor: '#e2e8f0',
        },
        icon: '—',
      };
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function getRefundStatusPresentation(status: RefundStatus): StatusBadgeDescriptor {
  switch (status) {
    case 'SUCCEEDED':
    case 'SETTLED_OFF_PLATFORM':
      return {
        label: 'Remboursé',
        badgeStyle: {
          backgroundColor: '#ecfdf5',
          color: '#047857',
          borderColor: '#a7f3d0',
        },
        icon: '✓',
      };
    case 'PENDING':
    case 'SUBMITTED':
      return {
        label: 'Remboursement en cours',
        badgeStyle: {
          backgroundColor: '#fffbeb',
          color: '#b45309',
          borderColor: '#fde68a',
        },
        icon: '⏳',
      };
    case 'FAILED':
    case 'FAILED_REQUIRES_MANUAL_ACTION':
      return {
        label: 'Intervention requise',
        badgeStyle: {
          backgroundColor: '#fef2f2',
          color: '#b91c1c',
          borderColor: '#fecaca',
        },
        icon: '⚠️',
      };
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Formatage monétaire et temporel standardisé
// ---------------------------------------------------------------------------

/**
 * Formate un montant en centimes/unités mineures avec devise.
 */
export function formatMoneyAmount(minorAmount: number, currency = 'EUR'): string {
  const amount = minorAmount / 100;
  try {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency,
      minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/**
 * Formate une date en français dans le fuseau horaire spécifié.
 */
export function formatHumanDate(
  dateInput: Date | string,
  timeZone = 'Europe/Paris',
  options?: Intl.DateTimeFormatOptions,
): string {
  const d = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  const defaultOpts: Intl.DateTimeFormatOptions = {
    dateStyle: 'long',
    timeZone,
  };
  try {
    return new Intl.DateTimeFormat('fr-FR', options ?? defaultOpts).format(d);
  } catch {
    return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' }).format(d);
  }
}
