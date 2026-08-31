import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getMembership, requireMembership } from '@uttily/core';
import { PageHeader } from '@uttily/ui';

export default async function SettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const user = await getAuthenticatedUser();
  if (!user) redirect('/sign-in');

  const db = getDb();
  const membership = await getMembership(db, orgId, user.id);
  requireMembership(membership, ['OWNER', 'ADMIN', 'MANAGER', 'STAFF']);

  return (
    <div style={layoutContainerStyle}>
      <PageHeader
        eyebrow="Organisation"
        title="Paramètres"
        description="Gérez l’identité commerciale de votre entreprise et vos politiques de service."
      />

      <nav aria-label="Sous-navigation Paramètres" style={navStyle}>
        <Link href={`/dashboard/${orgId}/settings/company`} style={tabLinkStyle}>
          Entreprise
        </Link>
        <Link href={`/dashboard/${orgId}/settings/policies`} style={tabLinkStyle}>
          Politiques
        </Link>
      </nav>

      <main>{children}</main>
    </div>
  );
}

const layoutContainerStyle: React.CSSProperties = {
  maxWidth: '1000px',
  margin: '0 auto',
  padding: '1.5rem',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ut-space-8)',
};

const navStyle: React.CSSProperties = {
  display: 'flex',
  gap: 'var(--ut-space-2)',
  borderBottom: 'var(--ut-border-thin)',
};

const tabLinkStyle: React.CSSProperties = {
  fontSize: 'var(--ut-text-sm)',
  fontWeight: 'var(--ut-weight-semibold)',
  color: 'var(--ut-color-primary-strong)',
  textDecoration: 'none',
  padding: 'var(--ut-space-3) var(--ut-space-3) var(--ut-space-2)',
  borderBottom: '2px solid transparent',
};
