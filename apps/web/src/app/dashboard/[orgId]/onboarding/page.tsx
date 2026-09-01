import { type ReactElement } from 'react';
import {
  getOrganizationById,
  getOrganizationOnboardingReadiness,
  resolveUnifiedOnboardingProgress,
} from '@uttily/core';
import { requireFulfillmentOperatorOf } from '@/lib/fulfillment-auth';
import { UnifiedOnboardingView } from '@/features/onboarding';

export default async function UnifiedOnboardingPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<ReactElement> {
  const { orgId } = await params;
  const { db, organizationId } = await requireFulfillmentOperatorOf(orgId);
  const organization = await getOrganizationById(db, organizationId);
  const readiness = await getOrganizationOnboardingReadiness(db, organizationId);
  const progress = resolveUnifiedOnboardingProgress(organizationId, readiness);

  return (
    <UnifiedOnboardingView
      organizationId={organizationId}
      organization={organization}
      progress={progress}
    />
  );
}
