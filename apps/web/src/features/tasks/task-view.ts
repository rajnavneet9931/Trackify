import { startOfZonedDay } from '../../lib/datetime';
import type { TaskListQuery, TaskPriority, TaskStatus } from './tasks.api';

/**
 * The task list's search, filters and sort, as kept in the URL so a view can
 * be refreshed or shared: `?q=&status=&priority=&assignee=&due=&overdue=1&sort=&order=`.
 */
export interface TaskView {
  q: string;
  status: TaskStatus | '';
  priority: TaskPriority | '';
  /** A user id, 'none' (unassigned) or '' (anyone). */
  assignee: string;
  /** '' (any), 'set', 'none', 'today' or 'week' (next 7 days), in local time. */
  due: '' | 'set' | 'none' | 'today' | 'week';
  overdue: boolean;
  sort: NonNullable<TaskListQuery['sortBy']>;
  order: 'asc' | 'desc';
}

export const DEFAULT_VIEW: TaskView = {
  q: '',
  status: '',
  priority: '',
  assignee: '',
  due: '',
  overdue: false,
  sort: 'createdAt',
  order: 'desc',
};

const STATUSES = ['TODO', 'IN_PROGRESS', 'DONE'];
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const DUES = ['set', 'none', 'today', 'week'];
const SORTS = ['createdAt', 'updatedAt', 'dueDate', 'priority', 'title'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads the view from URL parameters; anything unrecognized falls back to the default. */
export function viewFromParams(params: URLSearchParams): TaskView {
  const pick = <T extends string>(key: string, allowed: string[], fallback: T): T => {
    const value = params.get(key) ?? '';
    return (allowed.includes(value) ? value : fallback) as T;
  };
  const assignee = params.get('assignee') ?? '';
  return {
    q: (params.get('q') ?? '').slice(0, 200),
    status: pick('status', STATUSES, ''),
    priority: pick('priority', PRIORITIES, ''),
    assignee: assignee === 'none' || UUID.test(assignee) ? assignee : '',
    due: pick('due', DUES, ''),
    overdue: params.get('overdue') === '1',
    sort: pick('sort', SORTS, DEFAULT_VIEW.sort),
    order: pick('order', ['asc', 'desc'], DEFAULT_VIEW.order),
  };
}

/** URL parameters for a view; defaults are left out to keep URLs short. */
export function paramsFromView(view: TaskView): URLSearchParams {
  const params = new URLSearchParams();
  if (view.q.trim()) params.set('q', view.q.trim());
  if (view.status) params.set('status', view.status);
  if (view.priority) params.set('priority', view.priority);
  if (view.assignee) params.set('assignee', view.assignee);
  if (view.due) params.set('due', view.due);
  if (view.overdue) params.set('overdue', '1');
  if (view.sort !== DEFAULT_VIEW.sort) params.set('sort', view.sort);
  if (view.order !== DEFAULT_VIEW.order) params.set('order', view.order);
  return params;
}

/** True when no search or filter is active (sorting doesn't count). */
export function hasFilters(view: TaskView): boolean {
  return Boolean(
    view.q.trim() || view.status || view.priority || view.assignee || view.due || view.overdue,
  );
}

/**
 * The API query for a view. "Today" and "this week" are computed in the
 * user's time zone (preference, else device) and sent as UTC bounds.
 */
export function queryFromView(view: TaskView, now = new Date(), timeZone?: string): TaskListQuery {
  const query: TaskListQuery = { sortBy: view.sort, sortOrder: view.order };
  if (view.q.trim()) query.search = view.q.trim();
  if (view.status) query.status = view.status;
  if (view.priority) query.priority = view.priority;
  if (view.assignee === 'none') query.unassigned = true;
  else if (view.assignee) query.assigneeId = view.assignee;
  if (view.overdue) query.overdue = true;
  if (view.due === 'set') query.dueDate = 'any';
  if (view.due === 'none') query.dueDate = 'none';
  if (view.due === 'today') {
    const start = startOfZonedDay(now, timeZone);
    const end = startOfZonedDay(now, timeZone, 1);
    query.dueAfter = start.toISOString();
    query.dueBefore = end.toISOString();
  }
  if (view.due === 'week') {
    query.dueAfter = now.toISOString();
    query.dueBefore = new Date(now.getTime() + 7 * 24 * 3_600_000).toISOString();
  }
  return query;
}
