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
          backgroundColor: 'var(--ut-color-primary-soft)',
          color: 'var(--ut-color-primary-strong)',
          borderColor: 'var(--ut-color-primary-soft)',
        },
        icon: '✓',
      };
    case 'READY_FOR_PICKUP':
      return {
        label: 'Prête au retrait',
        badgeStyle: {
          backgroundColor: 'var(--ut-color-success-soft)',
          color: 'var(--ut-color-success)',
          borderColor: 'var(--ut-color-success-soft)',
        },
        icon: '🟢',
      };
    case 'ACTIVE':
      return {
        label: 'Location en cours',
        badgeStyle: {
          backgroundColor: 'var(--ut-color-success-soft)',
          color: 'var(--ut-color-success)',
          borderColor: 'var(--ut-color-success-soft)',
        },
        icon: '🧰',
      };
    case 'RETURNED':
      return {
        label: 'Équipement restitué · À réceptionner',
        badgeStyle: {
          backgroundColor: 'var(--ut-color-warning-soft)',
          color: 'var(--ut-color-warning)',
          borderColor: 'var(--ut-color-warning-soft)',
        },
        icon: '🔍',
      };
    case 'CLOSED':
      return {
        label: 'Dossier clôturé',
        badgeStyle: {
          backgroundColor: 'var(--ut-color-surface-raised)',
          color: 'var(--ut-color-ink-muted)',
          borderColor: 'var(--ut-color-border)',
        },
        icon: '🏁',
      };
    case 'CANCELLED':
      return {
        label: 'Annulée',
        badgeStyle: {
          backgroundColor: 'var(--ut-color-danger-soft)',
          color: 'var(--ut-color-danger)',
          borderColor: 'var(--ut-color-danger-soft)',
        },
        icon: '✕',
      };
    case 'REFUNDED':
      return {
        label: 'Annulée · Remboursée',
        badgeStyle: {
          backgroundColor: 'var(--ut-color-surface-raised)',
          color: 'var(--ut-color-ink-muted)',
          borderColor: 'var(--ut-color-border)',
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
          backgroundColor: 'var(--ut-color-success-soft)',
          color: 'var(--ut-color-success-strong)',
          borderColor: 'var(--ut-color-success-soft)',
        },
      };
    case 'GOOD':
      return {
        label: 'Bon état',
        badgeStyle: {
          backgroundColor: 'var(--ut-color-success-soft)',
          color: 'var(--ut-color-success)',
          borderColor: 'var(--ut-color-success-soft)',
        },
      };
    case 'FAIR':
      return {
        label: 'État correct',
        badgeStyle: {
          backgroundColor: 'var(--ut-color-warning-soft)',
          color: 'var(--ut-color-warning)',
          borderColor: 'var(--ut-color-warning-soft)',
        },
      };
    case 'POOR':
      return {
        label: 'Usagé',
        badgeStyle: {
          backgroundColor: 'var(--ut-color-accent-soft)',
          color: 'var(--ut-color-accent-strong)',
          borderColor: 'var(--ut-color-accent-soft)',
        },
      };
    case 'BROKEN':
      return {
        label: 'En réparation / Hors service',
        badgeStyle: {
          backgroundColor: 'var(--ut-color-danger-soft)',
          color: 'var(--ut-color-danger)',
          borderColor: 'var(--ut-color-danger-soft)',
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
        backgroundColor: 'var(--ut-color-accent-soft)',
        color: 'var(--ut-color-accent-strong)',
        borderColor: 'var(--ut-color-accent-soft)',
      },
      icon: '🔧',
    };
  }

  switch (status) {
    case 'ACTIVE':
      return {
        label: 'En service · Disponible',
        badgeStyle: {
          backgroundColor: 'var(--ut-color-success-soft)',
          color: 'var(--ut-color-success-strong)',
          borderColor: 'var(--ut-color-success-soft)',
        },
        icon: '🟢',
      };
    case 'RETIRED':
      return {
        label: 'Retiré du parc',
        badgeStyle: {
          backgroundColor: 'var(--ut-color-surface-soft)',
          color: 'var(--ut-color-ink-muted)',
          borderColor: 'var(--ut-color-border)',
        },
        icon: '⚫',
      };
    case 'LOST':
      return {
        label: 'Déclaré perdu / volé',
        badgeStyle: {
          backgroundColor: 'var(--ut-color-danger-soft)',
          color: 'var(--ut-color-danger)',
          borderColor: 'var(--ut-color-danger-soft)',
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
// 4. Synthèse de publication d'un équipement (Cockpit Pro)
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
          backgroundColor: 'var(--ut-color-success-soft)',
          color: 'var(--ut-color-success-strong)',
          borderColor: 'var(--ut-color-success-soft)',
        },
        icon: '🟢',
      };
    case 'ONLINE_UNAVAILABLE':
      return {
        label: 'En ligne · Indisponible',
        badgeStyle: {
          backgroundColor: 'var(--ut-color-danger-soft)',
          color: 'var(--ut-color-danger)',
          borderColor: 'var(--ut-color-danger-border)',
        },
        icon: '🔴',
      };
    case 'READY_TO_PUBLISH':
      return {
        label: 'Prêt à publier',
        badgeStyle: {
          backgroundColor: 'var(--ut-color-primary-soft)',
          color: 'var(--ut-color-primary-strong)',
          borderColor: 'var(--ut-color-primary-soft)',
        },
        icon: '🔵',
      };
    case 'INCOMPLETE':
      return {
        label: 'Configuration incomplète',
        badgeStyle: {
          backgroundColor: 'var(--ut-color-surface-raised)',
          color: 'var(--ut-color-ink-muted)',
          borderColor: 'var(--ut-color-border)',
        },
        icon: '⚪',
      };
    case 'ARCHIVED':
      return {
        label: 'Archivé',
        badgeStyle: {
          backgroundColor: 'var(--ut-color-surface-soft)',
          color: 'var(--ut-color-ink-muted)',
          borderColor: 'var(--ut-color-border-strong)',
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
          backgroundColor: 'var(--ut-color-success-soft)',
          color: 'var(--ut-color-success)',
          borderColor: 'var(--ut-color-success-soft)',
        },
        icon: '✓',
      };
    case 'PENDING_PROVIDER':
    case 'PROCESSING':
      return {
        label: 'Paiement en cours',
        badgeStyle: {
          backgroundColor: 'var(--ut-color-primary-soft)',
          color: 'var(--ut-color-primary-strong)',
          borderColor: 'var(--ut-color-primary-soft)',
        },
        icon: '⏳',
      };
    case 'REQUIRES_PAYMENT_METHOD':
    case 'REQUIRES_ACTION':
      return {
        label: 'Action de paiement requise',
        badgeStyle: {
          backgroundColor: 'var(--ut-color-warning-surface)',
          color: 'var(--ut-color-warning-strong)',
          borderColor: 'var(--ut-color-warning-border)',
        },
        icon: '⚠️',
      };
    case 'FAILED':
      return {
        label: 'Paiement échoué',
        badgeStyle: {
          backgroundColor: 'var(--ut-color-danger-soft)',
          color: 'var(--ut-color-danger)',
          borderColor: 'var(--ut-color-danger-soft)',
        },
        icon: '✕',
      };
    case 'CANCELLED':
      return {
        label: 'Paiement annulé',
        badgeStyle: {
          backgroundColor: 'var(--ut-color-surface-raised)',
          color: 'var(--ut-color-ink-muted)',
          borderColor: 'var(--ut-color-border)',
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
          backgroundColor: 'var(--ut-color-success-soft)',
          color: 'var(--ut-color-success)',
          borderColor: 'var(--ut-color-success-soft)',
        },
        icon: '✓',
      };
    case 'PENDING':
    case 'SUBMITTED':
      return {
        label: 'Remboursement en cours',
        badgeStyle: {
          backgroundColor: 'var(--ut-color-warning-surface)',
          color: 'var(--ut-color-warning-strong)',
          borderColor: 'var(--ut-color-warning-border)',
        },
        icon: '⏳',
      };
    case 'FAILED':
    case 'FAILED_REQUIRES_MANUAL_ACTION':
      return {
        label: 'Intervention requise',
        badgeStyle: {
          backgroundColor: 'var(--ut-color-danger-soft)',
          color: 'var(--ut-color-danger)',
          borderColor: 'var(--ut-color-danger-soft)',
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

export type PricingPlanType = 'DAILY' | 'HOURLY' | 'FIXED_DURATION';

/** Libellé métier et unité d’affichage du plan tarifaire réellement actif. */
export function getPricingPlanTypeLabel(planType: PricingPlanType): string {
  switch (planType) {
    case 'DAILY':
      return 'Tarif journalier';
    case 'HOURLY':
      return 'Tarif horaire';
    case 'FIXED_DURATION':
      return 'Forfait durée fixe';
  }
}

export function getPricingPlanUnitLabel(planType: PricingPlanType): string {
  switch (planType) {
    case 'DAILY':
      return '/ jour';
    case 'HOURLY':
      return '/ heure';
    case 'FIXED_DURATION':
      return '/ forfait';
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
