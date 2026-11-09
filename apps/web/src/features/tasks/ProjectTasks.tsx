import { useCallback, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { Avatar } from '../../components/ui/Avatar';
import { Icon } from '../../components/ui/Icon';
import { useToast } from '../../components/ui/toast-context';
import { buttonClass, cardClass } from '../../components/ui/styles';
import { ApiError } from '../../lib/api-client';
import { usePaginatedList } from '../../lib/usePaginatedList';
import { useDateTime } from '../account/preferences-context';
import { useAuth } from '../auth/auth-context';
import { CreateTaskForm } from './CreateTaskForm';
import { dueState } from './dates';
import { DueBadge } from './DueBadge';
import { STATUS_LABELS } from './labels';
import { ProjectTaskSummary } from './ProjectTaskSummary';
import { StatusGlyph, TaskPriorityBadge, TaskStatusBadge } from './TaskBadges';
import { TaskFilters } from './TaskFilters';
import {
  hasFilters,
  paramsFromView,
  queryFromView,
  viewFromParams,
  type TaskView,
} from './task-view';
import {
  listTasks,
  TASK_STATUSES,
  updateTaskStatus,
  type Task,
  type TaskStatus,
} from './tasks.api';
import { useAssignableMembers } from './useAssignableMembers';

const getKey = (task: Task) => task.id;

/** First line of the description, shortened for the list. */
function preview(description: string, max = 140): string {
  const firstLine = description.split('\n')[0]!;
  return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;
}

/** Desktop column layout shared by the header row and every task row. */
const COLUMNS =
  'md:grid md:grid-cols-[minmax(0,1fr)_9.5rem_6.5rem_11rem_8.5rem_2rem] md:items-center md:gap-4';

type MemberInfo = { userId: string; email: string; name?: string | null };

/**
 * A project's tasks for every workspace member: live counts, a toolbar
 * (search, filters, sort, Create task) whose view is kept in the URL
 * (`?q=&status=…`) so it can be refreshed or shared, and a compact table.
 * Members of an active project create tasks and change status in place;
 * archived projects are read-only. Mount with `key={projectId}`.
 */
export function ProjectTasks({
  workspaceId,
  projectId,
  archived,
  currentUserId = '',
}: {
  workspaceId: string;
  projectId: string;
  /** UX only: the API independently refuses changes in archived projects. */
  archived: boolean;
  currentUserId?: string;
}) {
  const [params, setParams] = useSearchParams();
  const view = useMemo(() => viewFromParams(params), [params]);
  const viewKey = paramsFromView(view).toString();
  const members = useAssignableMembers(workspaceId);
  const memberList = members.state.status === 'ready' ? members.state.members : [];
  const prependRef = useRef<((task: Task) => void) | null>(null);
  const [creating, setCreating] = useState(false);
  // Bumped after a create or a status change, so the summary counts reload.
  const [version, setVersion] = useState(0);
  const changed = useCallback(() => setVersion((v) => v + 1), []);

  const onChange = useCallback(
    (next: TaskView) => setParams(paramsFromView(next), { replace: true }),
    [setParams],
  );

  return (
    <section aria-labelledby="tasks-heading" className="mt-6">
      <h2 id="tasks-heading" className="text-base font-semibold text-slate-900">
        Tasks
      </h2>

      <ProjectTaskSummary workspaceId={workspaceId} projectId={projectId} version={version} />

      {archived && (
        <p className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          This project is archived, so its tasks are read-only.
        </p>
      )}

      <TaskFilters
        view={view}
        onChange={onChange}
        members={memberList}
        currentUserId={currentUserId}
        actions={
          !archived && (
            <button
              type="button"
              onClick={() => setCreating(!creating)}
              aria-expanded={creating}
              aria-controls="create-task-panel"
              className={buttonClass(creating ? 'secondary' : 'primary', 'sm')}
            >
              {creating ? (
                'Cancel'
              ) : (
                <>
                  <Icon name="plus" className="size-4" />
                  Create task
                </>
              )}
            </button>
          )
        }
      />

      {!archived && creating && (
        <div id="create-task-panel">
          <CreateTaskForm
            workspaceId={workspaceId}
            projectId={projectId}
            members={memberList}
            currentUserId={currentUserId}
            // A new task is shown at the top only when no filter could exclude it.
            onCreated={(task) => {
              if (!hasFilters(view)) prependRef.current?.(task);
              changed();
            }}
          />
        </div>
      )}

      {/* Remounted per query: changing search, filters or sort restarts pagination. */}
      <TaskResults
        key={viewKey}
        workspaceId={workspaceId}
        projectId={projectId}
        view={view}
        archived={archived}
        members={memberList}
        currentUserId={currentUserId}
        onStatusChanged={changed}
        onCreateFirst={archived ? undefined : () => setCreating(true)}
        registerPrepend={(fn) => {
          prependRef.current = fn;
        }}
      />
    </section>
  );
}

/**
 * One query's results: loading skeleton, empty state, the table, the count
 * and Load more. In active projects each row changes its status in place
 * (PATCH with the version shown; 409 if it changed elsewhere).
 */
function TaskResults({
  workspaceId,
  projectId,
  view,
  archived,
  members,
  currentUserId,
  onStatusChanged,
  onCreateFirst,
  registerPrepend,
}: {
  workspaceId: string;
  projectId: string;
  view: TaskView;
  archived: boolean;
  members: MemberInfo[];
  currentUserId: string;
  onStatusChanged: () => void;
  onCreateFirst?: (() => void) | undefined;
  registerPrepend: (fn: (task: Task) => void) => void;
}) {
  const dt = useDateTime();
  const { invalidateSession } = useAuth();
  const { notify } = useToast();
  const [statusPending, setStatusPending] = useState<ReadonlySet<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [total, setTotal] = useState<number | null>(null);
  const fetchPage = useCallback(
    async (cursor: string | undefined, signal?: AbortSignal) => {
      const page = await listTasks(
        workspaceId,
        projectId,
        { cursor, query: queryFromView(view, new Date(), dt.timeZone) },
        signal,
      );
      if (!cursor) setTotal(page.total);
      return { items: page.tasks, nextCursor: page.nextCursor };
    },
    // `view` is fixed for this mount (the parent remounts on change); the time
    // zone moves "today"/"next 7 days", so a new one reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceId, projectId, dt.timeZone],
  );
  const { state, retry, loadMore, prepend, update } = usePaginatedList({
    fetchPage,
    getKey,
    errorMessage: 'We couldn’t load the tasks of this project. Please try again.',
  });
  registerPrepend((task) => {
    prepend(task);
    setTotal((n) => (n === null ? n : n + 1));
  });
  const filtered = hasFilters(view);
  const nameOf = (id: string, email: string) => {
    const m = members.find((x) => x.userId === id);
    const name = m?.name ?? email;
    return id === currentUserId ? `${name} (you)` : name;
  };

  async function changeStatus(task: Task, status: TaskStatus) {
    if (status === task.status || statusPending.has(task.id)) return;
    setStatusPending((s) => new Set(s).add(task.id));
    setRowErrors(({ [task.id]: _dropped, ...rest }) => rest);
    try {
      const { task: updated } = await updateTaskStatus(
        workspaceId,
        projectId,
        task.id,
        status,
        task.updatedAt,
      );
      update(task.id, () => updated);
      onStatusChanged();
      notify(`“${updated.title}” is now ${STATUS_LABELS[updated.status]}.`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        invalidateSession();
        return;
      }
      const message =
        err instanceof ApiError && err.status === 409
          ? err.message.includes('archived')
            ? err.message
            : 'This task was changed by someone else. Open it to see the latest version.'
          : err instanceof ApiError && err.status === 404
            ? 'This task no longer exists.'
            : 'We couldn’t update the status. Please try again.';
      setRowErrors((e) => ({ ...e, [task.id]: message }));
    } finally {
      setStatusPending((s) => {
        const next = new Set(s);
        next.delete(task.id);
        return next;
      });
    }
  }

  return (
    <>
      {state.status === 'loading' && (
        <div className={`mt-3 ${cardClass} overflow-hidden`}>
          <p role="status" className="sr-only">
            Loading tasks…
          </p>
          <div aria-hidden="true" className="divide-y divide-slate-100">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex animate-pulse items-center gap-4 px-4 py-3">
                <div className="h-3.5 flex-1 rounded bg-slate-200" />
                <div className="hidden h-3 w-24 rounded bg-slate-100 md:block" />
                <div className="hidden h-3 w-16 rounded bg-slate-100 md:block" />
                <div className="hidden h-3 w-28 rounded bg-slate-100 md:block" />
              </div>
            ))}
          </div>
        </div>
      )}

      {state.status === 'error' && (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"
        >
          <p>{state.message}</p>
          <button
            type="button"
            onClick={retry}
            className={`mt-3 ${buttonClass('secondary', 'sm')}`}
          >
            Try again
          </button>
        </div>
      )}

      {state.status === 'ready' && state.items.length === 0 && (
        <div className="mt-3 rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
          <Icon name="list" className="mx-auto size-6 text-slate-400" />
          <p className="mt-2 text-sm font-medium text-slate-900">
            {filtered ? 'No tasks match these filters.' : 'No tasks yet.'}
          </p>
          <p className="mt-1 text-sm text-slate-500">
            {filtered
              ? 'Try another search or clear the filters.'
              : 'Break the project down into tasks your team can pick up.'}
          </p>
          {!filtered && onCreateFirst && (
            <button
              type="button"
              onClick={onCreateFirst}
              className={`mt-4 ${buttonClass('primary', 'sm')}`}
            >
              <Icon name="plus" className="size-4" />
              Create the first task
            </button>
          )}
        </div>
      )}

      {state.status === 'ready' && state.items.length > 0 && (
        <>
          <div className={`mt-3 ${cardClass} overflow-hidden`}>
            {/* Visual column headings; each row's cells carry their own labels. */}
            <div
              aria-hidden="true"
              className={`hidden border-b border-slate-200 bg-slate-50/80 px-4 py-2 text-xs font-medium text-slate-500 ${COLUMNS}`}
            >
              <span>Task</span>
              <span>Status</span>
              <span>Priority</span>
              <span>Assignee</span>
              <span>Due date</span>
              <span />
            </div>
            <ul aria-label="Tasks" className="divide-y divide-slate-100">
              {state.items.map((task) => {
                const path = `/workspaces/${workspaceId}/projects/${projectId}/tasks/${task.id}`;
                const due = dueState(task.dueDate, task.status, new Date(), dt.timeZone);
                return (
                  <li
                    key={task.id}
                    className={`group px-4 py-3 transition-colors hover:bg-slate-50 ${COLUMNS} ${
                      due === 'overdue' ? 'border-l-2 border-l-rose-500 pl-[14px]' : ''
                    }`}
                  >
                    <div className="min-w-0">
                      <h3 className="flex min-w-0 items-center gap-2 text-sm font-medium text-slate-900">
                        {archived && <StatusGlyph status={task.status} />}
                        <Link
                          to={path}
                          className="truncate hover:text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                        >
                          {task.title}
                        </Link>
                      </h3>
                      {task.description && (
                        <p className="mt-0.5 truncate text-xs text-slate-500">
                          {preview(task.description)}
                        </p>
                      )}
                    </div>

                    {/* Mobile: the cells below wrap into one compact line. */}
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 md:contents">
                      <div>
                        {archived ? (
                          <TaskStatusBadge status={task.status} />
                        ) : (
                          <>
                            <label className="sr-only" htmlFor={`status-${task.id}`}>
                              Change status of {task.title}
                            </label>
                            <select
                              id={`status-${task.id}`}
                              value={task.status}
                              onChange={(e) =>
                                void changeStatus(task, e.target.value as TaskStatus)
                              }
                              disabled={statusPending.has(task.id)}
                              className={`h-7 w-full max-w-[9.5rem] rounded-md border px-1.5 text-xs font-medium shadow-panel focus:ring-2 focus:ring-brand-100 focus:outline-none disabled:opacity-60 ${
                                task.status === 'DONE'
                                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                                  : task.status === 'IN_PROGRESS'
                                    ? 'border-sky-200 bg-sky-50 text-sky-800'
                                    : 'border-slate-300 bg-white text-slate-700'
                              }`}
                            >
                              {TASK_STATUSES.map((s) => (
                                <option key={s} value={s}>
                                  {STATUS_LABELS[s]}
                                </option>
                              ))}
                            </select>
                          </>
                        )}
                      </div>
                      <div>
                        <TaskPriorityBadge priority={task.priority} />
                      </div>
                      <div className="flex min-w-0 items-center gap-2 text-xs text-slate-700">
                        {task.assignee ? (
                          <>
                            <Avatar
                              label={nameOf(task.assignee.id, task.assignee.email)}
                              seed={task.assignee.id}
                              size="sm"
                            />
                            <span className="truncate">
                              <span className="sr-only">Assigned to </span>
                              {nameOf(task.assignee.id, task.assignee.email)}
                            </span>
                          </>
                        ) : (
                          <span className="text-slate-400">Unassigned</span>
                        )}
                      </div>
                      <div className="text-xs">
                        {task.dueDate ? (
                          <span
                            className={`inline-flex items-center gap-1 ${
                              due === 'overdue'
                                ? 'font-medium text-rose-700'
                                : due === 'today'
                                  ? 'font-medium text-amber-700'
                                  : 'text-slate-600'
                            }`}
                          >
                            {due === 'overdue' ? (
                              <Icon name="alert" className="size-3.5" />
                            ) : (
                              <Icon name="calendar" className="size-3.5 text-slate-400" />
                            )}
                            <span className="sr-only">Due </span>
                            <time dateTime={task.dueDate}>{dt.format(task.dueDate, 'date')}</time>
                          </span>
                        ) : null}
                        {task.dueDate ? (
                          <span className="ml-1.5 inline-block align-middle">
                            <DueBadge dueDate={task.dueDate} status={task.status} />
                          </span>
                        ) : (
                          <span className="text-slate-400">No due date</span>
                        )}
                      </div>
                      <div className="ml-auto md:ml-0 md:text-right">
                        <Link
                          to={path}
                          aria-label={`Open ${task.title}`}
                          className="inline-flex size-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                        >
                          <Icon name="chevronRight" className="size-4" />
                        </Link>
                      </div>
                    </div>
                    {rowErrors[task.id] && (
                      <p role="alert" className="mt-1 text-xs text-rose-700 md:col-span-6">
                        {rowErrors[task.id]}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500">
            {total !== null ? (
              <p>
                {total} {filtered ? 'matching ' : ''}task{total === 1 ? '' : 's'}
              </p>
            ) : (
              <span />
            )}
            <p role="status" className="sr-only">
              Showing {state.items.length} task{state.items.length === 1 ? '' : 's'}
            </p>
            {state.nextCursor && (
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={state.loadingMore}
                className={buttonClass('secondary', 'sm')}
              >
                {state.loadingMore ? 'Loading…' : 'Load more tasks'}
              </button>
            )}
          </div>

          {state.loadMoreError && (
            <p role="alert" className="mt-2 text-sm text-rose-700">
              {state.loadMoreError}
            </p>
          )}
        </>
      )}
    </>
  );
}
