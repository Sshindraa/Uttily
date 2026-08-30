'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type * as React from 'react';
import { Icon } from '@uttily/ui';
import styles from './pro-shell.module.css';

type ProShellProps = {
  orgId: string;
  organizationName: string;
  role: string;
  email: string;
  children: ReactNode;
};

const navItems = [
  { label: 'Accueil', href: (orgId: string) => `/dashboard/${orgId}`, icon: 'home' as const },
  {
    label: 'Mes équipements',
    href: (orgId: string) => `/dashboard/${orgId}/bikes`,
    icon: 'bike' as const,
  },
  {
    label: 'Réservations',
    href: (orgId: string) => `/dashboard/${orgId}/bookings`,
    icon: 'calendar' as const,
  },
  { label: 'Flotte', href: (orgId: string) => `/dashboard/${orgId}/fleet`, icon: 'bike' as const },
  {
    label: 'Établissements',
    href: (orgId: string) => `/dashboard/${orgId}/locations`,
    icon: 'pin' as const,
  },
  {
    label: 'Revenus',
    href: (orgId: string) => `/dashboard/${orgId}/finances`,
    icon: 'wallet' as const,
  },
  { label: 'Équipe', href: (orgId: string) => `/dashboard/${orgId}/team`, icon: 'users' as const },
  {
    label: 'Paramètres',
    href: (orgId: string) => `/dashboard/${orgId}/settings`,
    icon: 'settings' as const,
  },
];

export function ProShell({
  orgId,
  organizationName,
  role,
  email,
  children,
}: ProShellProps): React.JSX.Element {
  const pathname = usePathname() ?? '';
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const links = navItems.map((item) => ({ ...item, href: item.href(orgId) }));

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 64rem)');
    const updateViewport = () => setMobileViewport(mediaQuery.matches);
    updateViewport();
    mediaQuery.addEventListener('change', updateViewport);
    return () => mediaQuery.removeEventListener('change', updateViewport);
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMobileOpen(false);
      requestAnimationFrame(() => menuButtonRef.current?.focus());
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [mobileOpen]);

  return (
    <div className={styles.shell}>
      <header className={styles.mobileHeader}>
        <Link
          href={`/dashboard/${orgId}`}
          className={styles.brand}
          aria-label="Uttily Pro, accueil"
        >
          <span className={styles.brandMark}>U</span>
          <span>
            Uttily <em>Pro</em>
          </span>
        </Link>
        <button
          type="button"
          className={styles.menuButton}
          ref={menuButtonRef}
          aria-label={mobileOpen ? 'Fermer le menu' : 'Ouvrir le menu'}
          aria-expanded={mobileOpen}
          aria-controls="pro-navigation"
          onClick={() => setMobileOpen((open) => !open)}
        >
          <Icon name={mobileOpen ? 'x' : 'menu'} size={22} />
        </button>
      </header>

      {mobileOpen && (
        <button
          type="button"
          className={styles.scrim}
          aria-label="Fermer le menu"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        id="pro-navigation"
        className={`${styles.sidebar} ${mobileOpen ? styles.sidebarOpen : ''}`}
        aria-hidden={mobileViewport && !mobileOpen ? true : undefined}
        inert={mobileViewport && !mobileOpen ? true : undefined}
      >
        <div className={styles.sidebarTop}>
          <Link
            href={`/dashboard/${orgId}`}
            className={styles.brand}
            aria-label="Uttily Pro, accueil"
          >
            <span className={styles.brandMark}>U</span>
            <span>
              Uttily <em>Pro</em>
            </span>
          </Link>
          <div className={styles.orgContext}>
            <span className={styles.orgAvatar} aria-hidden="true">
              {organizationName.charAt(0).toUpperCase()}
            </span>
            <span className={styles.orgDetails}>
              <strong>{organizationName}</strong>
              <small>{role}</small>
            </span>
          </div>
        </div>

        <nav className={styles.navigation} aria-label="Navigation principale">
          <p className={styles.navLabel}>Espace loueur</p>
          <div className={styles.navGroup}>
            {links.slice(0, 6).map((item) => (
              <ProNavLink
                key={item.label}
                {...item}
                pathname={pathname}
                onNavigate={() => setMobileOpen(false)}
              />
            ))}
          </div>
          <div className={styles.navDivider} />
          <p className={styles.navLabel}>Organisation</p>
          <div className={styles.navGroup}>
            {links.slice(6).map((item) => (
              <ProNavLink
                key={item.label}
                {...item}
                pathname={pathname}
                onNavigate={() => setMobileOpen(false)}
              />
            ))}
          </div>
        </nav>

        <div className={styles.sidebarFooter}>
          <span className={styles.userEmail}>{email}</span>
          <Link href="/sign-in" className={styles.signOutLink}>
            Changer de compte
          </Link>
        </div>
      </aside>

      <main className={styles.mainContent}>{children}</main>
    </div>
  );
}

function ProNavLink({
  label,
  href,
  icon,
  pathname,
  onNavigate,
}: {
  label: string;
  href: string;
  icon: (typeof navItems)[number]['icon'];
  pathname: string;
  onNavigate: () => void;
}): React.JSX.Element {
  const active =
    label === 'Accueil' ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      className={`${styles.navLink} ${active ? styles.navLinkActive : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={onNavigate}
    >
      <Icon name={icon} size={19} />
      <span>{label}</span>
    </Link>
  );
}
