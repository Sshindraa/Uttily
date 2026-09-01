import { type ReactElement } from 'react';
import { redirect } from 'next/navigation';
import { createOrganizationAction } from '@/app/actions/organizations';
import { getAuthenticatedUser } from '@/lib/auth';
import { MVP_ORGANIZATION_CURRENCY } from '@uttily/core';
import { ClientShell } from '@/components/shells/client-shell';
import { OrganizationOnboardingView } from '@/features/onboarding';

export default async function OnboardingOrganizationPage(): Promise<ReactElement> {
  const user = await getAuthenticatedUser();

  if (!user) {
    redirect('/sign-in?redirect_url=%2Fonboarding%2Forganization');
  }

  async function createOrganization(formData: FormData): Promise<void> {
    'use server';

    const legalName = String(formData.get('legalName') ?? '');
    const slugRaw = String(formData.get('slug') ?? '');
    const defaultCurrency = String(formData.get('defaultCurrency') ?? MVP_ORGANIZATION_CURRENCY);
    const payload: Parameters<typeof createOrganizationAction>[0] = {
      legalName,
      defaultCurrency,
    };

    if (slugRaw) {
      payload.slug = slugRaw;
    }

    const { organization } = await createOrganizationAction(payload);
    redirect(`/dashboard/${organization.id}`);
  }

  return (
    <ClientShell>
      <OrganizationOnboardingView
        userEmail={user.email}
        defaultCurrency={MVP_ORGANIZATION_CURRENCY}
        createOrganization={createOrganization}
      />
    </ClientShell>
  );
}
