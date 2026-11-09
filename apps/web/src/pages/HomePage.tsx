import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { Icon } from '../components/ui/Icon';
import { Panel, StatTile } from '../components/ui/Panel';
import { buttonClass, cardClass } from '../components/ui/styles';
import { useDocumentTitle } from '../components/ui/useDocumentTitle';
import { useDateTime, usePreferences } from '../features/account/preferences-context';
import { useMyWork, type MyWorkTask } from '../features/home/useMyWork';
import { dueState } from '../features/tasks/dates';
import { StatusGlyph } from '../features/tasks/TaskBadges';
import { useAuth } from '../features/auth/auth-context';
import { SystemStatusCard } from '../features/system-status/SystemStatusCard';
import { CreateWorkspaceForm } from '../features/workspaces/CreateWorkspaceForm';
import { RoleBadge } from '../features/workspaces/RoleBadge';
import { listWorkspaces, type WorkspaceListItem } from '../features/workspaces/workspaces.api';
import { ApiError } from '../lib/api-client';
import { readRecentWorkspaces } from '../lib/recent-workspaces';

/** Enough for a count on the Home page; more shows as "100+". */
const HOME_LIST_LIMIT = 100;
const SHOWN = 4;

const FEATURES = [
  ['Workspaces and projects', 'Organize your team’s work, with owners and members.'],
  ['Tasks with deadlines', 'Assign, prioritize, comment and get reminded before things are due.'],
  ['Dashboards and history', 'See progress at a glance and every change in each task’s timeline.'],
] as const;

/** Signed out: what Trackify is, and how to get started. */
function Welcome() {
  const { session } = useAuth();
  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_22rem]">
      <section>
        <p className="text-sm font-semibold tracking-wide text-brand-600 uppercase">Trackify</p>
        <h1 className="mt-2 text-4xl font-bold tracking-tight text-slate-900">
          Plan, track and ship together.
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-slate-600">
          Trackify brings your team&apos;s projects, tasks and conversations into one place.
        </p>
        {session.status === 'unauthenticated' && (
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/register" className={buttonClass('primary')}>
              Create an account
            </Link>
            <Link to="/login" className={buttonClass('secondary')}>
              Sign in
            </Link>
          </div>
        )}
        <ul className="mt-10 grid gap-4 sm:grid-cols-3">
          {FEATURES.map(([title, text]) => (
            <li key={title} className={`${cardClass} p-4`}>
              <p className="text-sm font-semibold text-slate-900">{title}</p>
              <p className="mt-1 text-sm text-slate-600">{text}</p>
            </li>
          ))}
        </ul>
      </section>

      <SystemStatusCard />
    </div>
  );
}

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; items: WorkspaceListItem[]; more: boolean };

/** "Good morning" etc. by the viewer's clock. */
function greeting(now = new Date()) {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** One task in a Home list: status, title, where it lives, and when it's due. */
function WorkRow({ task }: { task: MyWorkTask }) {
  const dt = useDateTime();
  const due = dueState(task.dueDate, task.status, new Date(), dt.timeZone);
  return (
    <li className="relative flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50">
      <StatusGlyph status={task.status} />
      <div className="min-w-0 flex-1">
        <Link
          to={`/workspaces/${task.workspace.id}/projects/${task.project.id}/tasks/${task.id}`}
          className="block truncate text-sm font-medium text-slate-900 after:absolute after:inset-0 hover:text-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          {task.title}
        </Link>
        <p className="truncate text-xs text-slate-500">
          {task.workspace.name} · {task.project.name}
        </p>
      </div>
      {task.dueDate && (
        <span
          className={`shrink-0 text-xs ${
            due === 'overdue'
              ? 'font-medium text-rose-700'
              : due === 'today'
                ? 'font-medium text-amber-700'
                : 'text-slate-500'
          }`}
        >
          {due === 'overdue' ? 'Overdue · ' : due === 'today' ? 'Today · ' : ''}
          <time dateTime={task.dueDate}>{dt.format(task.dueDate, 'date')}</time>
        </span>
      )}
    </li>
  );
}

/**
 * Signed in: a personal work dashboard. A greeting, what needs attention
 * (overdue and due today), upcoming deadlines and open-task counts across
 * workspaces (from each workspace's dashboard, see useMyWork), recently
 * opened workspaces and quick workspace creation. All real data.
 */
function SignedInHome({ userId, email }: { userId: string; email: string }) {
  const { invalidateSession } = useAuth();
  const { displayName } = usePreferences();
  const dt = useDateTime();
  const navigate = useNavigate();
  const nameInput = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useDocumentTitle('Home');

  useEffect(() => {
    const controller = new AbortController();
    listWorkspaces({ limit: HOME_LIST_LIMIT }, controller.signal)
      .then((page) =>
        setState({ status: 'ready', items: page.workspaces, more: page.nextCursor !== null }),
      )
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) invalidateSession();
        else setState({ status: 'error', message: 'We couldn’t load your workspaces.' });
      });
    return () => controller.abort();
  }, [attempt, invalidateSession]);

  // Recently opened first (only those still in the list), then the rest.
  let ordered: WorkspaceListItem[] | null = null;
  let recentItems: WorkspaceListItem[] = [];
  if (state.status === 'ready') {
    const byId = new Map(state.items.map((w) => [w.id, w]));
    recentItems = readRecentWorkspaces(userId).flatMap((id) => byId.get(id) ?? []);
    const seen = new Set(recentItems.map((w) => w.id));
    ordered = [...recentItems, ...state.items.filter((w) => !seen.has(w.id))];
  }
  const recent = recentItems.length > 0;
  const work = useMyWork(ordered);
  const count = state.status === 'ready' ? state.items.length : 0;
  // Recently opened ones only; without history, the first workspaces.
  const shown = (recent ? recentItems : (ordered ?? [])).slice(0, SHOWN);
  const now = new Date();
  const attention =
    work.status === 'ready'
      ? work.tasks.filter((t) => {
          const due = dueState(t.dueDate, t.status, now, dt.timeZone);
          return due === 'overdue' || due === 'today';
        })
      : [];
  const upcoming =
    work.status === 'ready'
      ? work.tasks.filter((t) => {
          const due = dueState(t.dueDate, t.status, now, dt.timeZone);
          return t.dueDate && due !== 'overdue' && due !== 'today';
        })
      : [];
  const createPanel = (
    <Panel id="home-create-heading" title="Create a workspace">
      <p className="text-sm text-slate-600">You’ll be its owner and can invite your team.</p>
      <CreateWorkspaceForm
        inputRef={nameInput}
        onCreated={(workspace) => navigate(`/workspaces/${workspace.id}`)}
      />
    </Panel>
  );

  return (
    <div className="mx-auto max-w-6xl">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-slate-500">{dt.format(now.toISOString(), 'longDate')}</p>
        <h1 className="text-2xl font-bold tracking-tight break-words text-slate-900 sm:text-3xl">
          {displayName ? `${greeting(now)}, ${displayName}` : 'Welcome back'}
        </h1>
        <p className="text-sm break-words text-slate-500">Signed in as {email}</p>
      </header>

      {state.status === 'loading' && <LoadingState label="Loading your workspaces…" rows={3} />}
      {state.status === 'error' && (
        <ErrorState
          message={state.message}
          onRetry={() => {
            setState({ status: 'loading' });
            setAttempt((n) => n + 1);
          }}
        />
      )}

      {state.status === 'ready' && count === 0 && (
        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <EmptyState title="You’re not in any workspace yet">
            <p>
              Create one for your team. If someone invited you, open the invitation link they shared
              to join their workspace.
            </p>
          </EmptyState>
          <div className="mt-4">{createPanel}</div>
        </div>
      )}

      {state.status === 'ready' && count > 0 && (
        <>
          <dl aria-label="My work summary" className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="My open tasks"
              value={work.status === 'ready' ? work.pending : '—'}
              icon="list"
              tone="brand"
            />
            <StatTile
              label="Overdue"
              value={work.status === 'ready' ? work.overdue : '—'}
              icon="alert"
              tone={work.status === 'ready' && work.overdue > 0 ? 'danger' : 'neutral'}
            />
            <StatTile
              label="Due in 7 days"
              value={work.status === 'ready' ? work.upcoming : '—'}
              icon="calendar"
              tone="info"
            />
            <StatTile
              label="Workspaces"
              value={`${count}${state.more ? '+' : ''}`}
              hint={
                <Link to="/workspaces" className="relative z-10 text-brand-700 hover:underline">
                  View all workspaces →
                </Link>
              }
              icon="grid"
              tone="neutral"
            />
          </dl>

          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="min-w-0 space-y-4">
              <Panel id="attention-heading" title="Needs attention" flush>
                {work.status === 'loading' ? (
                  <p className="px-4 py-3 text-sm text-slate-500">Loading your tasks…</p>
                ) : attention.length === 0 ? (
                  <p className="flex items-center gap-2 px-4 py-4 text-sm text-slate-500">
                    <Icon name="checkCircle" className="size-4 text-emerald-600" />
                    Nothing overdue or due today. Nice.
                  </p>
                ) : (
                  <ul aria-label="Overdue and due today" className="divide-y divide-slate-100">
                    {attention.map((t) => (
                      <WorkRow key={t.id} task={t} />
                    ))}
                  </ul>
                )}
              </Panel>
              <Panel id="upcoming-heading" title="Upcoming deadlines" flush>
                {work.status === 'loading' ? (
                  <p className="px-4 py-3 text-sm text-slate-500">Loading your tasks…</p>
                ) : upcoming.length === 0 ? (
                  <p className="px-4 py-4 text-sm text-slate-500">
                    No upcoming deadlines on tasks assigned to you.
                  </p>
                ) : (
                  <ul aria-label="Upcoming deadlines" className="divide-y divide-slate-100">
                    {upcoming.map((t) => (
                      <WorkRow key={t.id} task={t} />
                    ))}
                  </ul>
                )}
              </Panel>
              {work.status === 'ready' && count > work.included && (
                <p className="text-xs text-slate-500">
                  Based on your {work.included} most recently opened workspace
                  {work.included === 1 ? '' : 's'}
                  {work.failed > 0 ? ` (${work.failed} couldn’t be loaded)` : ''}.
                </p>
              )}
            </div>

            <div className="min-w-0 space-y-4">
              <Panel id="recent-heading" title={recent ? 'Recently opened' : 'Jump back in'} flush>
                <ul className="divide-y divide-slate-100">
                  {shown.map((w) => (
                    <li
                      key={w.id}
                      className="relative flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50"
                    >
                      <span
                        aria-hidden="true"
                        className="flex size-7 shrink-0 items-center justify-center rounded-md bg-brand-50 text-xs font-semibold text-brand-700"
                      >
                        {w.name.slice(0, 1).toUpperCase()}
                      </span>
                      <Link
                        to={`/workspaces/${w.id}`}
                        className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900 after:absolute after:inset-0 hover:text-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                      >
                        {w.name}
                      </Link>
                      <RoleBadge role={w.role} />
                    </li>
                  ))}
                </ul>
              </Panel>
              {createPanel}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function HomePage() {
  const { session } = useAuth();
  if (session.status === 'authenticated') {
    return <SignedInHome userId={session.user.id} email={session.user.email} />;
  }
  return <Welcome />;
}
