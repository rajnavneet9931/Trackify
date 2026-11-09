import { Link, useParams } from 'react-router';

import { useAuth } from '../features/auth/auth-context';
import { BarList, ProjectCompletionList, StackedBar } from '../features/dashboard/DashboardCharts';
import { RecentActivity } from '../features/dashboard/RecentActivity';
import { useDashboard } from '../features/dashboard/useDashboard';
import { DueBadge } from '../features/tasks/DueBadge';
import { PRIORITY_LABELS, STATUS_LABELS } from '../features/tasks/labels';
import { StatusGlyph, TaskPriorityBadge, TaskStatusBadge } from '../features/tasks/TaskBadges';
import { TASK_PRIORITIES, TASK_STATUSES } from '../features/tasks/tasks.api';
import { useDateTime } from '../features/account/preferences-context';
import { WorkspaceNav } from '../features/workspaces/WorkspaceNav';
import { Icon } from '../components/ui/Icon';
import { Panel, StatTile } from '../components/ui/Panel';
import { buttonClass, linkClass } from '../components/ui/styles';
import { PageHeader } from '../components/ui/PageHeader';
import { LoadingState } from '../components/ui/States';
import { useWorkspaceDetail } from '../features/workspaces/useWorkspaceDetail';

/** Bar colours per status (same hues as the status indicators). */
const STATUS_BAR = {
  TODO: 'bg-slate-300',
  IN_PROGRESS: 'bg-sky-500',
  DONE: 'bg-emerald-500',
} as const;

function BackLink({ workspaceId }: { workspaceId: string }) {
  return (
    <Link to={`/workspaces/${workspaceId}`} className={linkClass}>
      ← Back to workspace
    </Link>
  );
}

/**
 * A workspace's dashboard for every member: task and project numbers, the
 * viewer's own work and the latest activity. Numbers come from the server
 * (aggregated in the database); dates are shown in the viewer's timezone.
 */
export function WorkspaceDashboardPage() {
  const dt = useDateTime();
  const { workspaceId = '' } = useParams();
  const { session } = useAuth();
  const { state, retry } = useDashboard(workspaceId);
  // Only for the breadcrumb's label; loaded in parallel and never blocks the page.
  const workspace = useWorkspaceDetail(workspaceId);
  const workspaceName =
    workspace.state.status === 'ready' ? workspace.state.detail.workspace.name : 'Workspace';
  const currentUserId = session.status === 'authenticated' ? session.user.id : '';

  if (state.status === 'loading') {
    return (
      <div className="mx-auto max-w-5xl">
        <LoadingState label="Loading dashboard…" rows={3} />
      </div>
    );
  }

  if (state.status === 'not-found') {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-2xl font-bold tracking-tight">Workspace not found</h1>
        <p className="mt-2 text-slate-600">
          This workspace doesn’t exist, or you don’t have access to it.
        </p>
        <div className="mt-6">
          <Link to="/workspaces" className={linkClass}>
            ← All workspaces
          </Link>
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div role="alert" className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-2xl font-bold tracking-tight">Can’t load the dashboard</h1>
        <p className="mt-2 text-slate-600">{state.message}</p>
        <button
          type="button"
          onClick={retry}
          className="mt-6 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          Try again
        </button>
        <div className="mt-4">
          <BackLink workspaceId={workspaceId} />
        </div>
      </div>
    );
  }

  const { tasks, projects, myWork, recentActivity } = state.dashboard;
  const empty = projects.active === 0 && projects.archived === 0;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        crumbs={[
          { label: 'Workspaces', to: '/workspaces' },
          { label: workspaceName, to: `/workspaces/${workspaceId}` },
          { label: 'Dashboard' },
        ]}
        title="Dashboard"
        documentTitle={`Dashboard · ${workspaceName}`}
        subtitle="Figures cover active projects; archived projects are not included."
        tabs={<WorkspaceNav workspaceId={workspaceId} />}
      />

      {empty ? (
        <div className="mt-6 rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
          <Icon name="chart" className="mx-auto size-6 text-slate-400" />
          <p className="mt-2 text-sm font-medium text-slate-900">No projects yet</p>
          <p className="mt-1 text-sm text-slate-600">
            Create a project to see task progress, workload and activity here.
          </p>
          <Link
            to={`/workspaces/${workspaceId}/projects`}
            className={`mt-4 ${buttonClass('primary', 'sm')}`}
          >
            <Icon name="plus" className="size-4" />
            Go to Projects
          </Link>
        </div>
      ) : (
        <>
          <dl
            aria-label="Summary"
            className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
          >
            <StatTile label="Total tasks" value={tasks.total} icon="list" tone="brand" />
            <StatTile
              label="Completed"
              value={tasks.byStatus.DONE}
              hint={
                tasks.total > 0
                  ? `${Math.round((tasks.byStatus.DONE / tasks.total) * 100)}% of all tasks`
                  : undefined
              }
              icon="checkCircle"
              tone="success"
            />
            <StatTile
              label="In progress"
              value={tasks.byStatus.IN_PROGRESS}
              icon="progress"
              tone="info"
            />
            <StatTile
              label="Overdue"
              value={tasks.overdue}
              hint={`${tasks.dueToday} due today · ${tasks.dueNext7Days} in the next 7 days`}
              icon="alert"
              tone={tasks.overdue > 0 ? 'danger' : 'neutral'}
            />
            <StatTile
              label="Active projects"
              value={projects.active}
              hint={projects.archived > 0 ? `${projects.archived} archived` : undefined}
              icon="folder"
              tone="neutral"
              // A real destination exists for this one: the Projects page.
              to={`/workspaces/${workspaceId}/projects`}
            />
          </dl>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Panel title="Tasks by status" id="status-heading">
              {tasks.total === 0 ? (
                <p className="text-sm text-slate-500">No tasks yet.</p>
              ) : (
                <>
                  <StackedBar
                    segments={TASK_STATUSES.map((s) => ({
                      key: s,
                      value: tasks.byStatus[s],
                      className: STATUS_BAR[s],
                    }))}
                    total={tasks.total}
                  />
                  <BarList
                    label="Tasks by status"
                    total={tasks.total}
                    items={TASK_STATUSES.map((s) => ({
                      key: s,
                      label: STATUS_LABELS[s],
                      value: tasks.byStatus[s],
                    }))}
                  />
                </>
              )}
            </Panel>
            <Panel title="Tasks by priority" id="priority-heading">
              {tasks.total === 0 ? (
                <p className="text-sm text-slate-500">No tasks yet.</p>
              ) : (
                <BarList
                  label="Tasks by priority"
                  total={tasks.total}
                  items={[...TASK_PRIORITIES].reverse().map((p) => ({
                    key: p,
                    label: PRIORITY_LABELS[p],
                    value: tasks.byPriority[p],
                  }))}
                />
              )}
            </Panel>
            <Panel title="Project completion" id="completion-heading">
              <ProjectCompletionList
                workspaceId={workspaceId}
                projects={projects.completion}
                activeCount={projects.active}
              />
            </Panel>
          </div>
        </>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="My work" id="my-work-heading">
          <dl className="grid grid-cols-4 gap-3 text-sm">
            {(
              [
                ['Assigned', myWork.assigned],
                ['Pending', myWork.pending],
                ['Overdue', myWork.overdue],
                ['Next 7 days', myWork.upcoming],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="rounded-md bg-slate-50 px-3 py-2">
                <dt className="text-xs text-slate-500">{label}</dt>
                <dd
                  className={`text-lg font-semibold tabular-nums ${
                    label === 'Overdue' && value > 0 ? 'text-rose-700' : 'text-slate-900'
                  }`}
                >
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <h3 className="mt-4 text-xs font-medium text-slate-500">Upcoming deadlines</h3>
          {myWork.tasks.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">Nothing assigned to you is open.</p>
          ) : (
            <ul aria-label="My open tasks" className="mt-1 divide-y divide-slate-100">
              {myWork.tasks.map((t) => (
                <li key={t.id} className="flex items-center gap-3 py-2 text-sm">
                  <StatusGlyph status={t.status} />
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/workspaces/${workspaceId}/projects/${t.project.id}/tasks/${t.id}`}
                      className="block truncate font-medium text-slate-900 hover:text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                    >
                      {t.title}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span className="truncate">{t.project.name}</span>
                      <TaskStatusBadge status={t.status} />
                      <TaskPriorityBadge priority={t.priority} />
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-xs text-slate-500">
                    {t.dueDate && (
                      <time dateTime={t.dueDate}>Due {dt.format(t.dueDate, 'date')}</time>
                    )}
                    <div className="mt-0.5">
                      <DueBadge dueDate={t.dueDate} status={t.status} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Recent activity" id="activity-heading">
          <RecentActivity
            workspaceId={workspaceId}
            activities={recentActivity}
            currentUserId={currentUserId}
          />
        </Panel>
      </div>
    </div>
  );
}
