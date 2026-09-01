import type { ReactElement } from 'react';
import { SupplementCheckoutClient } from './supplement-checkout-client';

export interface SupplementCheckoutPageViewProps {
  amendmentId: string;
  amountMinor: number;
  currency: string;
  holdDeadline: string;
  timeZone: string;
}

export function SupplementCheckoutPageView({
  amendmentId,
  amountMinor,
  currency,
  holdDeadline,
  timeZone,
}: SupplementCheckoutPageViewProps): ReactElement {
  return (
    <>
      <h1>Règlement du supplément</h1>
      <SupplementCheckoutClient
        amendmentId={amendmentId}
        amountMinor={amountMinor}
        currency={currency}
        holdDeadline={holdDeadline}
        timeZone={timeZone}
      />
    </>
  );
}
