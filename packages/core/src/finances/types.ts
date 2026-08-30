export type MerchantFinanceActivityType = 'PAYMENT' | 'REFUND';

export interface MerchantFinanceSales {
  grossAmountMinor: number;
  bookingCount: number;
}

export interface MerchantFinancePayments {
  succeededAmountMinor: number;
  pendingAmountMinor: number;
  refundedAmountMinor: number;
}

export interface MerchantFinanceCommissions {
  /** Frais plateforme imputables au loueur (legacy compatibility projection). */
  platformAmountMinor: number;
  /** Application fee technique Stripe, distinct du frais loueur en split. */
  platformApplicationFeeAmountMinor: number;
}

export interface MerchantFinanceMerchant {
  netAfterCommissionMinor: number;
}

export interface MerchantFinancePayoutItem {
  id: string;
  providerPayoutId: string;
  amountMinor: number;
  currency: string;
  status: 'PENDING' | 'IN_TRANSIT' | 'PAID' | 'FAILED' | 'CANCELLED';
  statusLabel: string;
  arrivalDate: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}

export interface MerchantFinancePayouts {
  totalPaidAmountMinor: number;
  inTransitAmountMinor: number;
  lastPayout: {
    amountMinor: number;
    arrivalDate: Date;
    status: string;
  } | null;
  nextPayoutSchedule: string;
  history: MerchantFinancePayoutItem[];
}

export interface MerchantFinanceActivityItem {
  id: string;
  type: MerchantFinanceActivityType;
  bookingId?: string | undefined;
  bookingReference: string;
  productName?: string | undefined;
  customerEmail?: string | undefined;
  grossAmountMinor: number;
  commissionAmountMinor: number;
  marketplaceFeeBaseAmountMinor?: number | undefined;
  merchantFeeAmountMinor?: number | undefined;
  customerServiceFeeAmountMinor?: number | undefined;
  customerTotalAmountMinor?: number | undefined;
  merchantNetAmountMinor?: number | undefined;
  platformApplicationFeeAmountMinor?: number | undefined;
  netAmountMinor: number;
  currency: string;
  status: string;
  statusLabel: string;
  date: Date;
}

export interface MerchantFinanceOverview {
  currency: 'EUR';
  period: {
    from: Date;
    to: Date;
    label: string;
  };
  sales: MerchantFinanceSales;
  payments: MerchantFinancePayments;
  commissions: MerchantFinanceCommissions;
  merchant: MerchantFinanceMerchant;
  payouts: MerchantFinancePayouts;
  activity: MerchantFinanceActivityItem[];
}

export interface MerchantFinanceFilterOptions {
  from?: Date | undefined;
  to?: Date | undefined;
  locationId?: string | undefined;
  type?: 'ALL' | 'PAYMENTS' | 'REFUNDS' | undefined;
  query?: string | undefined;
}
