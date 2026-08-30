import Link from 'next/link';
import { UserButton } from '@clerk/nextjs';

export default async function AccountLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale } = await params;

  return (
    <div style={layoutContainerStyle}>
      <header style={headerStyle}>
        <div style={headerInnerStyle}>
          <Link href={`/${locale}/search`} style={logoLinkStyle}>
            <span style={logoStyle}>Uttily</span>
          </Link>
          <nav style={navStyle}>
            <Link href={`/${locale}/account/bookings`} style={navLinkStyle}>
              Mes locations
            </Link>
            <Link href={`/${locale}/search`} style={navSecondaryLinkStyle}>
              Rechercher un équipement
            </Link>
            <div style={userWrapperStyle}>
              <UserButton afterSignOutUrl={`/${locale}/search`} />
            </div>
          </nav>
        </div>
      </header>
      <main style={mainStyle}>{children}</main>
    </div>
  );
}

const layoutContainerStyle: React.CSSProperties = {
  minHeight: '100vh',
  backgroundColor: '#f8fafc',
  color: '#0f172a',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
};

const headerStyle: React.CSSProperties = {
  backgroundColor: '#ffffff',
  borderBottom: '1px solid #e2e8f0',
  position: 'sticky',
  top: 0,
  zIndex: 30,
};

const headerInnerStyle: React.CSSProperties = {
  maxWidth: '960px',
  margin: '0 auto',
  padding: '0.875rem 1.25rem',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const logoLinkStyle: React.CSSProperties = {
  textDecoration: 'none',
};

const logoStyle: React.CSSProperties = {
  fontSize: '1.35rem',
  fontWeight: 800,
  letterSpacing: '-0.03em',
  color: '#0284c7',
};

const navStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '1.25rem',
};

const navLinkStyle: React.CSSProperties = {
  textDecoration: 'none',
  fontSize: '0.95rem',
  fontWeight: 600,
  color: '#0f172a',
};

const navSecondaryLinkStyle: React.CSSProperties = {
  textDecoration: 'none',
  fontSize: '0.95rem',
  fontWeight: 500,
  color: '#64748b',
};

const userWrapperStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  marginLeft: '0.5rem',
};

const mainStyle: React.CSSProperties = {
  maxWidth: '960px',
  margin: '0 auto',
  padding: '1.5rem 1.25rem 3rem 1.25rem',
};
