import { useEffect, useId, useState, type ReactNode } from 'react';

import { Icon } from '../../components/ui/Icon';
import { Popover } from '../../components/ui/Popover';
import { buttonClass, chipClass, compactControlClass } from '../../components/ui/styles';
import { PRIORITY_LABELS, STATUS_LABELS } from './labels';
import { DEFAULT_VIEW, hasFilters, type TaskView } from './task-view';
import { TASK_PRIORITIES, TASK_STATUSES } from './tasks.api';

/** Search waits this long after the last keystroke before updating the list. */
export const SEARCH_DEBOUNCE_MS = 300;

const label = 'block text-xs font-medium text-slate-600';
const field = `${compactControlClass} mt-1 w-full`;

const SORT_LABELS: Record<TaskView['sort'], string> = {
  createdAt: 'Created',
  updatedAt: 'Last updated',
  dueDate: 'Due date',
  priority: 'Priority',
  title: 'Title',
};
const DUE_LABELS: Record<Exclude<TaskView['due'], ''>, string> = {
  today: 'Due today',
  week: 'Due in the next 7 days',
  set: 'Has a due date',
  none: 'No due date',
};

/**
 * The task toolbar: search, a Filters menu, a Sort menu, the caller's
 * actions (Create task) and the active filters as removable chips. Every
 * change (search after a short pause) is reported through `onChange`; the
 * caller keeps the view in the URL.
 */
export function TaskFilters({
  view,
  onChange,
  members,
  currentUserId,
  actions,
}: {
  view: TaskView;
  onChange: (view: TaskView) => void;
  /** Workspace members for the assignee filter (may be empty while loading). */
  members: { userId: string; email: string; name?: string | null }[];
  currentUserId: string;
  actions?: ReactNode;
}) {
  const id = useId();
  const [text, setText] = useState(view.q);
  const [syncedQ, setSyncedQ] = useState(view.q);

  // Follow external changes (e.g. "Clear all", back/forward navigation),
  // adjusting state while rendering rather than in an effect.
  if (view.q !== syncedQ) {
    setSyncedQ(view.q);
    setText(view.q);
  }

  // Debounce typing into the search box.
  useEffect(() => {
    if (text === view.q) return;
    const timer = setTimeout(() => onChange({ ...view, q: text }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, view, onChange]);

  const set = <K extends keyof TaskView>(key: K, value: TaskView[K]) =>
    onChange({ ...view, [key]: value });

  const memberName = (userId: string) => {
    const m = members.find((x) => x.userId === userId);
    if (!m) return 'Selected member';
    return userId === currentUserId ? 'Me' : (m.name ?? m.email);
  };

  // Active filters as chips (search shows in its own field).
  const chips: { key: string; text: string; clear: Partial<TaskView> }[] = [];
  if (view.status)
    chips.push({
      key: 'status',
      text: `Status: ${STATUS_LABELS[view.status]}`,
      clear: { status: '' },
    });
  if (view.priority)
    chips.push({
      key: 'priority',
      text: `Priority: ${PRIORITY_LABELS[view.priority]}`,
      clear: { priority: '' },
    });
  if (view.assignee)
    chips.push({
      key: 'assignee',
      text: view.assignee === 'none' ? 'Unassigned' : `Assignee: ${memberName(view.assignee)}`,
      clear: { assignee: '' },
    });
  if (view.due) chips.push({ key: 'due', text: DUE_LABELS[view.due], clear: { due: '' } });
  if (view.overdue) chips.push({ key: 'overdue', text: 'Overdue', clear: { overdue: false } });
  const filterCount = chips.length;
  const sorted = view.sort !== DEFAULT_VIEW.sort || view.order !== DEFAULT_VIEW.order;

  return (
    <div role="search" aria-label="Filter tasks" className="mt-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <label htmlFor={`${id}-q`} className="sr-only">
            Search
          </label>
          <Icon
            name="search"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400"
          />
          <input
            id={`${id}-q`}
            type="search"
            value={text}
            maxLength={200}
            placeholder="Search tasks"
            onChange={(e) => setText(e.target.value)}
            className={`${compactControlClass} w-full pl-8`}
          />
        </div>

        <Popover
          label={filterCount ? `Filters, ${filterCount} active` : 'Filters'}
          buttonClassName={buttonClass('secondary', 'sm')}
          buttonContent={
            <>
              <Icon name="filter" className="size-3.5" />
              Filters
              {filterCount > 0 && (
                <span className="rounded-full bg-brand-600 px-1.5 text-[11px] leading-4 font-semibold text-white">
                  {filterCount}
                </span>
              )}
            </>
          }
          panelClassName="w-72"
        >
          {() => (
            <div className="space-y-3">
              <div>
                <label htmlFor={`${id}-status`} className={label}>
                  Status
                </label>
                <select
                  id={`${id}-status`}
                  value={view.status}
                  onChange={(e) => set('status', e.target.value as TaskView['status'])}
                  className={field}
                >
                  <option value="">Any status</option>
                  {TASK_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`${id}-priority`} className={label}>
                  Priority
                </label>
                <select
                  id={`${id}-priority`}
                  value={view.priority}
                  onChange={(e) => set('priority', e.target.value as TaskView['priority'])}
                  className={field}
                >
                  <option value="">Any priority</option>
                  {TASK_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {PRIORITY_LABELS[p]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`${id}-assignee`} className={label}>
                  Assignee
                </label>
                <select
                  id={`${id}-assignee`}
                  value={view.assignee}
                  onChange={(e) => set('assignee', e.target.value)}
                  className={field}
                >
                  <option value="">Anyone</option>
                  <option value="none">Unassigned</option>
                  {view.assignee &&
                    view.assignee !== 'none' &&
                    !members.some((m) => m.userId === view.assignee) && (
                      <option value={view.assignee}>Selected member</option>
                    )}
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.userId === currentUserId ? `${m.email} (you)` : m.email}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`${id}-due`} className={label}>
                  Due date
                </label>
                <select
                  id={`${id}-due`}
                  value={view.due}
                  onChange={(e) => {
                    const due = e.target.value as TaskView['due'];
                    // "No due date" can't be combined with overdue (the API refuses it).
                    onChange({ ...view, due, overdue: due === 'none' ? false : view.overdue });
                  }}
                  className={field}
                >
                  <option value="">Any due date</option>
                  <option value="today">Due today</option>
                  <option value="week">Due in the next 7 days</option>
                  <option value="set">Has a due date</option>
                  <option value="none">No due date</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={view.overdue}
                  onChange={(e) =>
                    onChange({
                      ...view,
                      overdue: e.target.checked,
                      due: e.target.checked && view.due === 'none' ? '' : view.due,
                    })
                  }
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                />
                Overdue only
              </label>
            </div>
          )}
        </Popover>

        <Popover
          label="Sort"
          buttonClassName={buttonClass('secondary', 'sm')}
          buttonContent={
            <>
              <Icon name="sort" className="size-3.5" />
              <span>
                Sort<span className="hidden sm:inline">: {SORT_LABELS[view.sort]}</span>
              </span>
            </>
          }
          panelClassName="w-60"
        >
          {() => (
            <div className="space-y-3">
              <div>
                <label htmlFor={`${id}-sort`} className={label}>
                  Sort by
                </label>
                <select
                  id={`${id}-sort`}
                  value={view.sort}
                  onChange={(e) => set('sort', e.target.value as TaskView['sort'])}
                  className={field}
                >
                  {(Object.keys(SORT_LABELS) as TaskView['sort'][]).map((s) => (
                    <option key={s} value={s}>
                      {SORT_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`${id}-order`} className={label}>
                  Order
                </label>
                <select
                  id={`${id}-order`}
                  value={view.order}
                  onChange={(e) => set('order', e.target.value as TaskView['order'])}
                  className={field}
                >
                  <option value="desc">Descending</option>
                  <option value="asc">Ascending</option>
                </select>
              </div>
            </div>
          )}
        </Popover>

        {actions}
      </div>

      {(chips.length > 0 || hasFilters(view) || sorted) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <span key={chip.key} className={chipClass}>
              {chip.text}
              <button
                type="button"
                onClick={() => onChange({ ...view, ...chip.clear })}
                aria-label={`Remove filter ${chip.text}`}
                className="rounded-full p-0.5 text-brand-700 hover:bg-brand-100"
              >
                <Icon name="x" className="size-3" />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={() => {
              setText('');
              onChange(DEFAULT_VIEW);
            }}
            className="ml-1 text-xs font-medium text-slate-600 hover:text-slate-900 hover:underline"
          >
            Clear all filters
          </button>
        </div>
      )}
    </div>
  );
}
