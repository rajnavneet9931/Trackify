import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';

import { PageHeader } from '../components/ui/PageHeader';
import { Avatar } from '../components/ui/Avatar';
import { Icon } from '../components/ui/Icon';
import { Panel, StatTile } from '../components/ui/Panel';
import { buttonClass, linkClass } from '../components/ui/styles';
import { useAuth } from '../features/auth/auth-context';
import { getDashboard, type Dashboard } from '../features/dashboard/dashboard.api';
import { RecentActivity } from '../features/dashboard/RecentActivity';
import { useDateTime } from '../features/account/preferences-context';
import { ProjectStatusBadge } from '../features/projects/ProjectStatusBadge';
import { listProjects, type Project } from '../features/projects/projects.api';
import { RoleBadge } from '../features/workspaces/RoleBadge';
import { WorkspaceGate } from '../features/workspaces/WorkspaceGate';
import { WorkspaceNav } from '../features/workspaces/WorkspaceNav';
import {
  getWorkspaceSettings,
  listMembers,
  type WorkspaceDetail,
  type WorkspaceMember,
} from '../features/workspaces/workspaces.api';

const PREVIEW = 5;

type Preview<T> =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; items: T[]; more: boolean };

/** Loads one small, non-critical preview; a failure just shows a short note. */
function usePreview<T>(
  load: (signal: AbortSignal) => Promise<{ items: T[]; more: boolean }>,
  key: string,
): Preview<T> {
  const [state, setState] = useState<{ key: string; value: Preview<T> }>({
    key,
    value: { status: 'loading' },
  });
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal)
      .then((page) => setState({ key, value: { status: 'ready', ...page } }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ key, value: { status: 'error' } });
      });
    return () => controller.abort();
    // `load` is recreated on every render; `key` identifies what it loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state.value : { status: 'loading' };
}

function Overview({ detail }: { detail: WorkspaceDetail }) {
  const dt = useDateTime();
  const { session } = useAuth();
  const { workspace, membership } = detail;
  const isOwner = membership.role === 'OWNER';
  const base = `/workspaces/${workspace.id}`;

  // Four independent requests, in parallel.
  const description = usePreview<string | null>(async (signal) => {
    const { settings } = await getWorkspaceSettings(workspace.id, signal);
    return { items: [settings.description], more: false };
  }, `${workspace.id}:settings`);
  const projects = usePreview<Project>(async (signal) => {
    const page = await listProjects(workspace.id, { limit: PREVIEW }, signal);
    return { items: page.projects, more: page.nextCursor !== null };
  }, `${workspace.id}:projects`);
  const members = usePreview<WorkspaceMember>(async (signal) => {
    const page = await listMembers(workspace.id, { limit: PREVIEW }, signal);
    return { items: page.members, more: page.nextCursor !== null };
  }, `${workspace.id}:members`);

  const dashboard = usePreview<Dashboard>(async (signal) => {
    const d = await getDashboard(workspace.id, signal);
    return { items: [d], more: false };
  }, `${workspace.id}:dashboard`);

  const descriptionText = description.status === 'ready' ? description.items[0] : null;
  const stats = dashboard.status === 'ready' ? dashboard.items[0]! : null;
  const completionOf = (projectId: string) =>
    stats?.projects.completion.find((c) => c.id === projectId) ?? null;
  const currentUserId = session.status === 'authenticated' ? session.user.id : '';

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        crumbs={[{ label: 'Workspaces', to: '/workspaces' }, { label: workspace.name }]}
        title={workspace.name}
        badge={<RoleBadge role={membership.role} prefix="Your role: " />}
        subtitle={
          <>
            Created{' '}
            <time dateTime={workspace.createdAt}>{dt.format(workspace.createdAt, 'longDate')}</time>
          </>
        }
        actions={
          <>
            <Link to={`${base}/dashboard`} className={buttonClass('secondary', 'sm')}>
              <Icon name="chart" className="size-3.5" />
              Dashboard
            </Link>
            {isOwner && (
              <Link to={`${base}/projects`} className={buttonClass('primary', 'sm')}>
                <Icon name="plus" className="size-4" />
                New project
              </Link>
            )}
          </>
        }
        tabs={<WorkspaceNav workspaceId={workspace.id} />}
      />

      <section aria-labelledby="workspace-info-heading" className="mt-5">
        <h2 id="workspace-info-heading" className="sr-only">
          About this workspace
        </h2>
        {description.status === 'loading' && (
          <div aria-hidden="true" className="h-4 w-2/3 animate-pulse rounded bg-slate-200" />
        )}
        {description.status !== 'loading' &&
          (descriptionText ? (
            <p className="max-w-3xl text-sm leading-6 break-words whitespace-pre-line text-slate-700">
              {descriptionText}
            </p>
          ) : (
            <p className="text-sm text-slate-500">
              No description yet.
              {isOwner && (
                <>
                  {' '}
                  <Link to={`${base}/settings`} className={linkClass}>
                    Add one in Settings
                  </Link>
                </>
              )}
            </p>
          ))}
      </section>

      <dl aria-label="Workspace summary" className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Open tasks"
          value={stats ? stats.tasks.total - stats.tasks.byStatus.DONE : '—'}
          icon="list"
          tone="brand"
        />
        <StatTile
          label="Completed"
          value={stats ? stats.tasks.byStatus.DONE : '—'}
          icon="checkCircle"
          tone="success"
        />
        <StatTile
          label="Overdue"
          value={stats ? stats.tasks.overdue : '—'}
          icon="alert"
          tone={stats && stats.tasks.overdue > 0 ? 'danger' : 'neutral'}
        />
        <StatTile
          label="Active projects"
          value={stats ? stats.projects.active : '—'}
          icon="folder"
          to={`${base}/projects`}
        />
      </dl>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          <Panel
            id="recent-projects-heading"
            title="Recent projects"
            flush
            action={
              <Link to={`${base}/projects`} className={linkClass}>
                {isOwner ? 'Create or view projects →' : 'View all projects →'}
              </Link>
            }
          >
            {projects.status === 'loading' && (
              <p className="px-4 py-3 text-sm text-slate-500">Loading projects…</p>
            )}
            {projects.status === 'error' && (
              <p className="px-4 py-3 text-sm text-slate-500">
                Projects couldn’t be loaded right now.
              </p>
            )}
            {projects.status === 'ready' && projects.items.length === 0 && (
              <p className="px-4 py-4 text-sm text-slate-500">
                No projects yet.{isOwner ? ' Create the first one on the Projects page.' : ''}
              </p>
            )}
            {projects.status === 'ready' && projects.items.length > 0 && (
              <ul aria-label="Recent projects" className="divide-y divide-slate-100">
                {projects.items.map((p) => {
                  const completion = completionOf(p.id);
                  return (
                    <li
                      key={p.id}
                      className="relative flex items-center gap-3 px-4 py-3 hover:bg-slate-50"
                    >
                      <span
                        aria-hidden="true"
                        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-500"
                      >
                        <Icon name="folder" className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <Link
                          to={`${base}/projects/${p.id}`}
                          className="block truncate text-sm font-medium text-slate-900 after:absolute after:inset-0 hover:text-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                        >
                          {p.name}
                        </Link>
                        {completion && completion.totalTasks > 0 ? (
                          <div className="mt-1 flex items-center gap-2">
                            <div
                              aria-hidden="true"
                              className="h-1.5 w-28 overflow-hidden rounded-full bg-slate-100"
                            >
                              <div
                                className="h-full rounded-full bg-brand-600"
                                style={{ width: `${completion.completionPercent}%` }}
                              />
                            </div>
                            <span className="text-xs text-slate-500">
                              {completion.completionPercent}% · {completion.doneTasks}/
                              {completion.totalTasks} done
                            </span>
                          </div>
                        ) : (
                          <p className="mt-0.5 truncate text-xs text-slate-500">
                            {p.description ?? (completion ? 'No tasks yet' : '')}
                          </p>
                        )}
                      </div>
                      <ProjectStatusBadge status={p.status} />
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel
            id="overview-activity-heading"
            title="Recent activity"
            action={
              <Link to={`${base}/dashboard`} className={linkClass}>
                Dashboard →
              </Link>
            }
          >
            {dashboard.status === 'loading' && (
              <p className="text-sm text-slate-500">Loading activity…</p>
            )}
            {dashboard.status === 'error' && (
              <p className="text-sm text-slate-500">Activity couldn’t be loaded right now.</p>
            )}
            {stats && (
              <RecentActivity
                workspaceId={workspace.id}
                activities={stats.recentActivity.slice(0, 6)}
                currentUserId={currentUserId}
              />
            )}
          </Panel>
        </div>

        <Panel
          id="members-preview-heading"
          title="Members"
          flush
          className="self-start"
          action={
            <Link to={`${base}/members`} className={linkClass}>
              {isOwner ? 'Manage →' : 'View all →'}
            </Link>
          }
        >
          {members.status === 'loading' && (
            <p className="px-4 py-3 text-sm text-slate-500">Loading members…</p>
          )}
          {members.status === 'error' && (
            <p className="px-4 py-3 text-sm text-slate-500">
              Members couldn’t be loaded right now.
            </p>
          )}
          {members.status === 'ready' && (
            <ul aria-label="Members preview" className="divide-y divide-slate-100">
              {members.items.map((m) => (
                <li key={m.userId} className="flex items-center gap-2.5 px-4 py-2.5 text-sm">
                  <Avatar label={m.name ?? m.email} seed={m.userId} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-slate-800">{m.name ?? m.email}</p>
                    {m.name && <p className="truncate text-xs text-slate-500">{m.email}</p>}
                  </div>
                  <RoleBadge role={m.role} />
                </li>
              ))}
              {members.more && <li className="px-4 py-2 text-xs text-slate-500">and more…</li>}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

/**
 * A workspace's overview (only reachable through <RequireAuth>): a summary
 * with its description, recent projects and members. Projects, Members,
 * Dashboard and Settings are their own pages (the workspace tabs).
 */
export function WorkspaceDetailPage() {
  const { workspaceId = '' } = useParams();
  return (
    <WorkspaceGate workspaceId={workspaceId}>
      {(detail) => <Overview detail={detail} />}
    </WorkspaceGate>
  );
}
