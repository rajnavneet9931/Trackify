import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';

import { useAuth } from '../features/auth/auth-context';
import { TaskActivityTimeline } from '../features/activity/TaskActivityTimeline';
import { TaskComments } from '../features/comments/TaskComments';
import { useProjectDetail } from '../features/projects/useProjectDetail';
import { EditTaskForm } from '../features/tasks/EditTaskForm';
import { TaskAssignee } from '../features/tasks/TaskAssignee';
import { DueBadge } from '../features/tasks/DueBadge';
import { TaskPriorityBadge, TaskStatusBadge } from '../features/tasks/TaskBadges';
import type { TaskDetail } from '../features/tasks/tasks.api';
import { useTaskDetail } from '../features/tasks/useTaskDetail';
import { useWorkspaceDetail } from '../features/workspaces/useWorkspaceDetail';
import { useDateTime, type DateTimeTools } from '../features/account/preferences-context';
import { PageHeader } from '../components/ui/PageHeader';
import { LoadingState } from '../components/ui/States';
import { Icon } from '../components/ui/Icon';
import { buttonClass, cardClass, eyebrowClass, linkClass } from '../components/ui/styles';
import { TaskQuickFields } from '../features/tasks/TaskQuickFields';
import { WorkspaceNav } from '../features/workspaces/WorkspaceNav';

function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className={linkClass}>
      ← {label}
    </Link>
  );
}

function Notice({ title, back, children }: { title: string; back: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      <div className="mt-2 text-slate-600">{children}</div>
      <div className="mt-6">
        <BackLink to={back} label="Back to project" />
      </div>
    </div>
  );
}

/**
 * One task (only reachable through <RequireAuth>). Every workspace member can
 * view it and, while the project is active, edit it. The project is loaded
 * alongside for its name and status (archived → read-only).
 */
export function TaskDetailPage() {
  const dt = useDateTime();
  const { workspaceId = '', projectId = '', taskId = '' } = useParams();
  const { session } = useAuth();
  const project = useProjectDetail(workspaceId, projectId);
  const task = useTaskDetail(workspaceId, projectId, taskId);
  // Only for the viewer's role (owners may delete any comment); doesn't block the page.
  const workspace = useWorkspaceDetail(workspaceId);
  const [editing, setEditing] = useState<string | null>(null); // id of the task being edited
  const [notice, setNotice] = useState<{ taskId: string; text: string }>();
  const projectPath = `/workspaces/${workspaceId}/projects/${projectId}`;

  const states = [project.state.status, task.state.status];
  if (states.includes('loading')) {
    return (
      <div className="mx-auto max-w-5xl">
        <LoadingState label="Loading task…" rows={3} />
      </div>
    );
  }

  // An inaccessible workspace or project looks exactly like a missing task.
  if (states.includes('not-found') || states.includes('forbidden')) {
    return (
      <Notice title="Task not found" back={projectPath}>
        <p>This task doesn’t exist, or you don’t have access to it.</p>
      </Notice>
    );
  }

  if (project.state.status !== 'ready' || task.state.status !== 'ready') {
    const message =
      task.state.status === 'error'
        ? task.state.message
        : project.state.status === 'error'
          ? project.state.message
          : 'Something went wrong. Please try again.';
    return (
      <div role="alert" className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-2xl font-bold tracking-tight">Can’t load this task</h1>
        <p className="mt-2 text-slate-600">{message}</p>
        <button
          type="button"
          onClick={() => {
            if (project.state.status !== 'ready') project.retry();
            task.retry();
          }}
          className="mt-6 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          Try again
        </button>
        <div className="mt-4">
          <BackLink to={projectPath} label="Back to project" />
        </div>
      </div>
    );
  }

  const { project: parent } = project.state.detail;
  const { task: current, creator } = task.state.detail;
  const archived = parent.status === 'ARCHIVED';
  const isEditing = !archived && editing === current.id;
  const currentUserId = session.status === 'authenticated' ? session.user.id : '';
  const showNotice = notice?.taskId === current.id ? notice.text : undefined;

  const workspaceName =
    workspace.state.status === 'ready' ? workspace.state.detail.workspace.name : 'Workspace';
  const startEditing = () => {
    setNotice(undefined);
    setEditing(current.id);
  };

  const isOwner =
    workspace.state.status === 'ready' && workspace.state.detail.membership.role === 'OWNER';
  const creatorName = creator
    ? creator.id === currentUserId
      ? `${creator.email} (you)`
      : creator.email
    : 'A former member';

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        crumbs={[
          { label: 'Workspaces', to: '/workspaces' },
          { label: workspaceName, to: `/workspaces/${workspaceId}` },
          { label: 'Projects', to: `/workspaces/${workspaceId}/projects` },
          { label: parent.name, to: projectPath },
          { label: current.title },
        ]}
        title={current.title}
        documentTitle={`${current.title} · ${parent.name}`}
        badge={<DueBadge dueDate={current.dueDate} status={current.status} />}
        actions={
          // UX only: the API independently refuses edits in archived projects.
          !archived && !isEditing ? (
            <button type="button" onClick={startEditing} className={buttonClass('secondary', 'sm')}>
              <Icon name="settings" className="size-3.5" />
              Edit task
            </button>
          ) : undefined
        }
        tabs={<WorkspaceNav workspaceId={workspaceId} />}
      />

      {showNotice && (
        <p
          role="status"
          className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {showNotice}
        </p>
      )}

      {archived && (
        <p className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          This project is archived, so its tasks are read-only.
        </p>
      )}

      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start">
        {/* Main column: the work itself. */}
        <div className="min-w-0 space-y-6">
          {isEditing ? (
            <EditTaskForm
              workspaceId={workspaceId}
              task={current}
              onCancel={() => setEditing(null)}
              onReload={() => {
                setEditing(null);
                task.retry();
              }}
              onSaved={(updated) => {
                setEditing(null);
                task.replaceTask(updated);
                setNotice({ taskId: updated.id, text: 'Task updated.' });
              }}
            />
          ) : (
            <section aria-label="Task details" className={`${cardClass} p-5`}>
              <h2 className="text-xs font-medium text-slate-500">Description</h2>
              {current.description ? (
                <p className="mt-1.5 text-sm leading-6 break-words whitespace-pre-line text-slate-800">
                  {current.description}
                </p>
              ) : (
                <p className="mt-1.5 text-sm text-slate-500 italic">No description.</p>
              )}
            </section>
          )}

          {/* Keyed by task: another task never shows this discussion. */}
          <TaskComments
            key={current.id}
            target={{ workspaceId, projectId, taskId: current.id }}
            currentUserId={currentUserId}
            isOwner={isOwner}
            readOnly={archived}
          />

          {/* Read-only history, also in archived projects; keyed by task. */}
          <TaskActivityTimeline
            key={`activity-${current.id}`}
            target={{ workspaceId, projectId, taskId: current.id }}
            currentUserId={currentUserId}
          />
        </div>

        {/* Side panel: properties, edited in place. */}
        <aside
          aria-label="Task properties"
          className={`${cardClass} divide-y divide-slate-100 lg:sticky lg:top-20`}
        >
          <div className="p-4">
            {archived ? (
              <dl className="grid gap-3">
                <div>
                  <dt className={eyebrowClass}>Status</dt>
                  <dd className="mt-1">
                    <TaskStatusBadge status={current.status} />
                  </dd>
                </div>
                <div>
                  <dt className={eyebrowClass}>Priority</dt>
                  <dd className="mt-1">
                    <TaskPriorityBadge priority={current.priority} />
                  </dd>
                </div>
              </dl>
            ) : (
              !isEditing && (
                <TaskQuickFields
                  workspaceId={workspaceId}
                  task={current}
                  onChanged={task.replaceTask}
                  onReload={task.retry}
                />
              )
            )}
            {!archived && isEditing && (
              <p className="text-xs text-slate-500">
                Status and priority are in the form while editing.
              </p>
            )}
          </div>

          <div className="p-4">
            {/* Read-only in archived projects; the API enforces membership and archival. */}
            <TaskAssignee
              workspaceId={workspaceId}
              task={current}
              readOnly={archived}
              currentUserId={currentUserId}
              onChanged={task.replaceTask}
            />
          </div>

          <dl className="grid gap-3 p-4 text-sm">
            <div>
              <dt className={eyebrowClass}>Due date</dt>
              <dd className="mt-0.5 flex items-center gap-1.5 text-slate-800">
                <Icon name="calendar" className="size-3.5 text-slate-400" />
                {current.dueDate ? (
                  <time dateTime={current.dueDate}>{dt.format(current.dueDate)}</time>
                ) : (
                  'No due date'
                )}
              </dd>
            </div>
            <div>
              <dt className={eyebrowClass}>Reminder</dt>
              <dd className="mt-0.5 flex items-center gap-1.5 text-slate-800">
                <Icon name="clock" className="size-3.5 text-slate-400" />
                {reminderText(current.reminderAt, task.state.detail.reminder, dt)}
              </dd>
            </div>
          </dl>

          <dl className="grid gap-3 p-4 text-xs text-slate-600">
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Created by</dt>
              <dd className="min-w-0 truncate text-right text-slate-800" title={creatorName}>
                {creatorName}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Created</dt>
              <dd className="text-right">
                <time dateTime={current.createdAt}>{dt.format(current.createdAt)}</time>
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Last updated</dt>
              <dd className="text-right">
                <time dateTime={current.updatedAt}>{dt.format(current.updatedAt)}</time>
              </dd>
            </div>
          </dl>
        </aside>
      </div>
    </div>
  );
}

/** The reminder's state in plain words (times in the user's local timezone). */
function reminderText(
  reminderAt: string | null,
  reminder: TaskDetail['reminder'],
  dt: DateTimeTools,
): string {
  if (!reminderAt) return 'No reminder';
  const when = dt.format(reminderAt);
  switch (reminder?.status) {
    case 'SENT':
      return `Reminder sent ${dt.format(reminder.sentAt ?? reminder.remindAt)}`;
    case 'FAILED':
      return `Reminder for ${when} could not be delivered`;
    case 'CANCELLED':
      return `Reminder for ${when} was cancelled`;
    default:
      return `Reminder scheduled for ${when}`;
  }
}
