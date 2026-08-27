import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getMembership, requireMembership } from '@uttily/core';

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
      <header style={headerStyle}>
        <h1 style={titleStyle}>Paramètres</h1>
        <p style={subtitleStyle}>
          Gérez l’identité commerciale de votre entreprise et vos politiques de service.
        </p>

        <nav aria-label="Sous-navigation Paramètres" style={navStyle}>
          <Link href={`/dashboard/${orgId}/settings/company`} style={tabLinkStyle}>
            Entreprise
          </Link>
          <Link href={`/dashboard/${orgId}/settings/policies`} style={tabLinkStyle}>
            Politiques
          </Link>
        </nav>
      </header>

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
  gap: '1.5rem',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  borderBottom: '1px solid #e2e8f0',
  paddingBottom: '1rem',
};

const titleStyle: React.CSSProperties = {
  fontSize: '1.75rem',
  fontWeight: 700,
  color: '#0f172a',
  margin: 0,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: '0.95rem',
  color: '#64748b',
  margin: 0,
};

const navStyle: React.CSSProperties = {
  display: 'flex',
  gap: '1.5rem',
  marginTop: '0.75rem',
};

const tabLinkStyle: React.CSSProperties = {
  fontSize: '0.95rem',
  fontWeight: 600,
  color: '#2563eb',
  textDecoration: 'none',
  paddingBottom: '0.25rem',
};
