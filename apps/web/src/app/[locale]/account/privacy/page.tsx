import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { getUserPrivacyRequests } from '@uttily/core';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { PrivacyView } from '@/features/privacy';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const fr = locale === 'fr';
  return {
    title: fr
      ? 'Confidentialité et données personnelles · Uttily'
      : 'Privacy and personal data · Uttily',
    description: fr
      ? 'Gérez vos données personnelles et exercez vos droits RGPD.'
      : 'Manage your personal data and exercise your GDPR rights.',
  };
}

export default async function AccountPrivacyPage({
  params,
}: PageProps): Promise<React.ReactElement> {
  const { locale } = await params;
  const user = await getAuthenticatedUser();
  if (!user) {
    redirect(`/sign-in?redirect_url=${encodeURIComponent(`/${locale}/account/privacy`)}`);
    return <></>;
  }

  const db = getDb();
  const requests = await getUserPrivacyRequests(db, user.id);

  return <PrivacyView locale={locale} requests={requests} />;
}
