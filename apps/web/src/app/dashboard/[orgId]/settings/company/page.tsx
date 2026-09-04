import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getOrganizationById, getMembership, requireMembership, can } from '@uttily/core';
import { updateCompanyLegalSettingsAction } from '@/app/actions/settings';
import { CompanySettingsView } from '@/features/settings';

export default async function CompanySettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const user = await getAuthenticatedUser();
  if (!user) redirect('/sign-in');

  const db = getDb();
  const membership = await getMembership(db, orgId, user.id);
  const active = requireMembership(membership, ['OWNER', 'ADMIN', 'MANAGER', 'STAFF']);

  const organization = await getOrganizationById(db, orgId);
  if (!organization) redirect('/dashboard');

  const canManage = can(active.role, 'organization.manage');

  async function updateCompany(formData: FormData) {
    'use server';
    const publicDisplayName = String(formData.get('publicDisplayName') ?? '').trim();
    const legalName = String(formData.get('legalName') ?? '').trim();
    const legalForm = String(formData.get('legalForm') ?? '').trim();
    const registrationNumber = String(formData.get('registrationNumber') ?? '').trim();
    const vatNumber = String(formData.get('vatNumber') ?? '').trim();
    const registryCity = String(formData.get('registryCity') ?? '').trim();
    const capitalAmount = String(formData.get('capitalAmount') ?? '').trim();
    const legalRepresentativeName = String(formData.get('legalRepresentativeName') ?? '').trim();
    const registeredOfficeAddress = String(formData.get('registeredOfficeAddress') ?? '').trim();
    const registeredOfficePostalCode = String(
      formData.get('registeredOfficePostalCode') ?? '',
    ).trim();
    const registeredOfficeCity = String(formData.get('registeredOfficeCity') ?? '').trim();
    const registeredOfficeCountryCode = String(
      formData.get('registeredOfficeCountryCode') ?? 'FR',
    ).trim();

    await updateCompanyLegalSettingsAction(orgId, {
      legalName: legalName.length > 0 ? legalName : null,
      publicDisplayName: publicDisplayName.length > 0 ? publicDisplayName : null,
      legalForm: legalForm.length > 0 ? legalForm : null,
      registrationNumber: registrationNumber.length > 0 ? registrationNumber : null,
      vatNumber: vatNumber.length > 0 ? vatNumber : null,
      registryCity: registryCity.length > 0 ? registryCity : null,
      capitalAmount: capitalAmount.length > 0 ? capitalAmount : null,
      legalRepresentativeName: legalRepresentativeName.length > 0 ? legalRepresentativeName : null,
      registeredOfficeAddress: registeredOfficeAddress.length > 0 ? registeredOfficeAddress : null,
      registeredOfficePostalCode:
        registeredOfficePostalCode.length > 0 ? registeredOfficePostalCode : null,
      registeredOfficeCity: registeredOfficeCity.length > 0 ? registeredOfficeCity : null,
      registeredOfficeCountryCode:
        registeredOfficeCountryCode.length > 0 ? registeredOfficeCountryCode : 'FR',
    });
    redirect(`/dashboard/${orgId}/settings/company`);
  }

  return (
    <CompanySettingsView
      organization={organization}
      canManage={canManage}
      updateCompany={updateCompany}
    />
  );
}
