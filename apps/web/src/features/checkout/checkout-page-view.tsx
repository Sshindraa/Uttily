import type { ReactElement } from 'react';
import { CheckoutClient } from './checkout-client';

export interface CheckoutPageLine {
  variantId: string;
  quantity: number;
  lineTotalAmountMinor: number;
  title: string;
}

export interface CheckoutPageViewProps {
  draftId: string;
  returnUrl: string;
  baseAmountMinor: number;
  customerServiceFeeAmountMinor: number;
  customerTotalAmountMinor: number;
  hasMarketplaceFeeSnapshot: boolean;
  currency: string;
  lines: CheckoutPageLine[];
  renterName: string;
  expiresAt: string | null;
  locale: 'fr' | 'en';
}

export function CheckoutPageView({
  draftId,
  returnUrl,
  baseAmountMinor,
  customerServiceFeeAmountMinor,
  customerTotalAmountMinor,
  hasMarketplaceFeeSnapshot,
  currency,
  lines,
  renterName,
  expiresAt,
  locale,
}: CheckoutPageViewProps): ReactElement {
  return (
    <main style={pageStyle}>
      <CheckoutClient
        draftId={draftId}
        returnUrl={returnUrl}
        baseAmountMinor={baseAmountMinor}
        customerServiceFeeAmountMinor={customerServiceFeeAmountMinor}
        customerTotalAmountMinor={customerTotalAmountMinor}
        hasMarketplaceFeeSnapshot={hasMarketplaceFeeSnapshot}
        currency={currency}
        lines={lines}
        renterName={renterName}
        expiresAt={expiresAt}
        locale={locale}
      />
    </main>
  );
}

const pageStyle: React.CSSProperties = {
  maxWidth: 540,
  margin: '2rem auto',
  padding: '1rem',
};
