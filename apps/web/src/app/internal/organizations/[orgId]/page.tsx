import { notFound } from 'next/navigation';
import { getOrganizationSupportDetails, SupportOrganizationNotFoundError } from '@uttily/core';
import { OrganizationSupportView } from '@/features/internal';
import { requireSupportPlatformAdmin } from '@/lib/support-auth';

export const dynamic = 'force-dynamic';

export default async function OrganizationSupportPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { db } = await requireSupportPlatformAdmin();
  const { orgId } = await params;

  try {
    const org = await getOrganizationSupportDetails(db, orgId);
    return <OrganizationSupportView org={org} />;
  } catch (err) {
    if (err instanceof SupportOrganizationNotFoundError) {
      notFound();
    }
    throw err;
  }
}
