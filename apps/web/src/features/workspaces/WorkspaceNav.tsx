import { useEffect } from 'react';
import { Link, useLocation } from 'react-router';

import { useAuth } from '../auth/auth-context';
import { rememberWorkspace } from '../../lib/recent-workspaces';

export type WorkspaceSection = 'overview' | 'dashboard' | 'projects' | 'members' | 'settings';

/**
 * The workspace's tabs, each a real page (so back/forward, refresh and
 * opening in a new tab all work): Overview, Dashboard, Projects, Members,
 * Settings. Project and task pages live under Projects. Wraps instead of
 * scrolling on narrow screens, so no tab is hidden. Also records the
 * workspace as recently opened (Home page).
 */
export function WorkspaceNav({ workspaceId }: { workspaceId: string }) {
  const { pathname } = useLocation();
  const { session } = useAuth();
  const userId = session.status === 'authenticated' ? session.user.id : null;
  const base = `/workspaces/${workspaceId}`;

  useEffect(() => {
    if (userId) rememberWorkspace(userId, workspaceId);
  }, [userId, workspaceId]);

  const under = (path: string) => pathname === path || pathname.startsWith(`${path}/`);
  const active: WorkspaceSection = under(`${base}/dashboard`)
    ? 'dashboard'
    : under(`${base}/settings`)
      ? 'settings'
      : under(`${base}/projects`)
        ? 'projects'
        : under(`${base}/members`)
          ? 'members'
          : 'overview';

  const items: { id: WorkspaceSection; label: string; to: string }[] = [
    { id: 'overview', label: 'Overview', to: base },
    { id: 'dashboard', label: 'Dashboard', to: `${base}/dashboard` },
    { id: 'projects', label: 'Projects', to: `${base}/projects` },
    { id: 'members', label: 'Members', to: `${base}/members` },
    { id: 'settings', label: 'Settings', to: `${base}/settings` },
  ];

  return (
    <nav aria-label="Workspace" className="mt-4 border-b border-slate-200">
      <ul className="-mb-px flex flex-wrap gap-x-1">
        {items.map((item) => {
          const isActive = item.id === active;
          return (
            <li key={item.id}>
              <Link
                to={item.to}
                aria-current={isActive ? 'page' : undefined}
                className={`inline-block border-b-2 px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${
                  isActive
                    ? 'border-brand-600 text-brand-700'
                    : 'border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900'
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
