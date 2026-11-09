import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';

import { Avatar } from '../components/ui/Avatar';
import { Icon, type IconName } from '../components/ui/Icon';
import { usePreferences } from '../features/account/preferences-context';
import { useAuth } from '../features/auth/auth-context';
import { LogoutFailureBanner, SignOutButton } from '../features/auth/SignOut';
import { NotificationBell } from '../features/notifications/NotificationBell';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${
    isActive
      ? 'bg-brand-50 text-brand-700'
      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
  }`;

function NavItem({
  to,
  icon,
  label,
  end,
}: {
  to: string;
  icon: IconName;
  label: string;
  end?: boolean;
}) {
  return (
    <NavLink to={to} end={end} className={navLinkClass}>
      <Icon name={icon} className="size-4 opacity-80" />
      {label}
    </NavLink>
  );
}

function AccountNav() {
  const { session } = useAuth();
  const { displayName } = usePreferences();

  if (session.status === 'authenticated') {
    const shown = displayName ?? session.user.email;
    return (
      <>
        <NavItem to="/workspaces" icon="grid" label="Workspaces" />
        <span aria-hidden="true" className="mx-1 hidden h-5 w-px bg-slate-200 md:block" />
        <NavLink
          to="/account"
          className={(state) => `${navLinkClass(state)} min-w-0 md:max-w-56`}
          title={session.user.email}
        >
          <Avatar label={shown} seed={session.user.id} size="sm" />
          <span className="sr-only">Signed in as {session.user.email}</span>
          <span aria-hidden="true" className="truncate">
            {shown}
          </span>
        </NavLink>
        <SignOutButton className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60 md:w-auto" />
      </>
    );
  }
  if (session.status === 'unauthenticated') {
    return (
      <>
        <NavLink to="/login" className={navLinkClass}>
          Sign in
        </NavLink>
        <Link
          to="/register"
          className="flex items-center rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-panel hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          Create account
        </Link>
      </>
    );
  }
  // loading / unavailable: show nothing rather than a possibly wrong state.
  return null;
}

/**
 * The app shell: a slim header with the brand, the primary navigation
 * (Home, Workspaces), the notification bell, the signed-in person and Sign
 * out; then the page. Below the `md` breakpoint the links fold behind a menu
 * button (the bell stays visible); the menu closes on navigation.
 */
export function RootLayout() {
  const { session } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPath, setMenuPath] = useState(location.pathname);

  // Close the mobile menu when the page changes (adjusting state during render).
  if (menuPath !== location.pathname) {
    setMenuPath(location.pathname);
    if (menuOpen) setMenuOpen(false);
  }

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:shadow-pop"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="relative mx-auto flex h-14 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
          <Link
            to="/"
            className="flex shrink-0 items-center gap-2 rounded-md text-base font-semibold tracking-tight text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
          >
            <img src="/favicon.svg" alt="" className="size-6" />
            Trackify
          </Link>
          <div className="flex min-w-0 items-center gap-1">
            {session.status === 'authenticated' && <NotificationBell />}
            <button
              type="button"
              onClick={() => setMenuOpen(!menuOpen)}
              aria-expanded={menuOpen}
              aria-controls="main-nav"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              className="rounded-md p-2 text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 md:hidden"
            >
              <Icon name={menuOpen ? 'x' : 'list'} className="size-5" />
            </button>
            <nav
              id="main-nav"
              aria-label="Main"
              className={`${
                menuOpen ? 'flex' : 'hidden'
              } absolute inset-x-0 top-14 flex-col gap-1 border-b border-slate-200 bg-white p-3 shadow-pop md:static md:order-first md:mr-2 md:flex md:flex-row md:items-center md:gap-0.5 md:border-0 md:bg-transparent md:p-0 md:shadow-none`}
            >
              <NavItem to="/" end icon="home" label="Home" />
              <AccountNav />
            </nav>
          </div>
        </div>
      </header>
      <LogoutFailureBanner />

      <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <Outlet />
      </main>

      <footer className="border-t border-slate-200 py-4 text-center text-xs text-slate-500">
        © {new Date().getFullYear()} Trackify
      </footer>
    </div>
  );
}
