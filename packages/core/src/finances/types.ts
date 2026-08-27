export type MerchantFinanceActivityType = 'PAYMENT' | 'REFUND' | 'PAYOUT';

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
  platformAmountMinor: number;
}

export interface MerchantFinanceMerchant {
  netAfterCommissionMinor: number;
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
  netAmountMinor: number;
  currency: string;
  status: string;
  statusLabel: string;
  payoutStatus: 'NOT_APPLICABLE' | 'PENDING' | 'IN_TRANSIT' | 'PAID';
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
  type?: 'ALL' | 'PAYMENTS' | 'REFUNDS' | 'PAYOUTS' | undefined;
  query?: string | undefined;
}
