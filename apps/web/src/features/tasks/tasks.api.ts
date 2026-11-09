import { apiRequest, apiRequestEnvelope } from '../../lib/api-client';

export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE';
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export const TASK_STATUSES: readonly TaskStatus[] = ['TODO', 'IN_PROGRESS', 'DONE'];
export const TASK_PRIORITIES: readonly TaskPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  createdById: string;
  assigneeId: string | null;
  /** Always a member of the workspace (enforced by the API); null when unassigned. */
  assignee: { id: string; email: string } | null;
  /** Deadline (UTC ISO), or null. */
  dueDate: string | null;
  /** When to remind (UTC ISO), or null. */
  reminderAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetail {
  task: Task;
  /** Only while the creator is still a member of the workspace; otherwise null. */
  creator: { id: string; email: string } | null;
  /** Delivery state of the latest scheduled reminder, if any. */
  reminder: {
    status: 'PENDING' | 'SENT' | 'FAILED' | 'CANCELLED';
    remindAt: string;
    sentAt: string | null;
  } | null;
}

export const TASK_PAGE_SIZE = 20;

const tasksPath = (workspaceId: string, projectId: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/tasks`;

/** Search, filters and sorting for the task list (all optional; see the API docs). */
export interface TaskListQuery {
  search?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeId?: string;
  unassigned?: boolean;
  dueDate?: 'any' | 'none';
  /** UTC ISO bounds: due at or after / strictly before. */
  dueAfter?: string;
  dueBefore?: string;
  overdue?: boolean;
  sortBy?: 'createdAt' | 'updatedAt' | 'dueDate' | 'priority' | 'title';
  sortOrder?: 'asc' | 'desc';
}

/**
 * GET (any workspace member). Newest first unless sorted otherwise.
 * `nextCursor` is null on the last page; `total` (matching tasks) comes with
 * the first page only.
 */
export async function listTasks(
  workspaceId: string,
  projectId: string,
  {
    cursor,
    limit = TASK_PAGE_SIZE,
    query = {},
  }: { cursor?: string | undefined; limit?: number; query?: TaskListQuery } = {},
  signal?: AbortSignal,
): Promise<{ tasks: Task[]; nextCursor: string | null; total: number | null }> {
  const params = new URLSearchParams({ limit: String(limit) });
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '' && value !== false) params.set(key, String(value));
  }
  if (cursor) params.set('cursor', cursor);

  const { data, meta } = await apiRequestEnvelope<
    { tasks: Task[] },
    { nextCursor?: string | null; total?: number }
  >(`${tasksPath(workspaceId, projectId)}?${params}`, signal ? { signal } : {});
  return { tasks: data.tasks, nextCursor: meta?.nextCursor ?? null, total: meta?.total ?? null };
}

/**
 * POST (any member, active projects only). Status defaults to TODO; an
 * assignee must be a member of the workspace (422 otherwise).
 */
export function createTask(
  workspaceId: string,
  projectId: string,
  input: {
    title: string;
    description?: string;
    priority: TaskPriority;
    status?: TaskStatus;
    assigneeId?: string;
    dueDate?: string;
    reminderAt?: string;
  },
): Promise<{ task: Task }> {
  return apiRequest(tasksPath(workspaceId, projectId), { method: 'POST', body: input });
}

export function getTask(
  workspaceId: string,
  projectId: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<TaskDetail> {
  return apiRequest(
    `${tasksPath(workspaceId, projectId)}/${encodeURIComponent(taskId)}`,
    signal ? { signal } : {},
  );
}

/**
 * PATCH (any member, active projects only). `expectedUpdatedAt` is the
 * `updatedAt` the user saw: if someone changed the task since, the API answers
 * 409 instead of overwriting their change.
 */
export function updateTask(
  workspaceId: string,
  projectId: string,
  taskId: string,
  input: {
    title: string;
    description: string | null;
    status: TaskStatus;
    priority: TaskPriority;
    /** null removes the due date. */
    dueDate: string | null;
    /** null removes the reminder. */
    reminderAt: string | null;
    expectedUpdatedAt: string;
  },
): Promise<{ task: Task }> {
  return apiRequest(`${tasksPath(workspaceId, projectId)}/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: input,
  });
}

/**
 * PATCH with only the status (e.g. from the task list), with the same
 * `expectedUpdatedAt` precondition: 409 if the task changed since.
 */
/** PATCH one or two quick fields (status, priority) with the version seen; 409 if stale. */
export function updateTaskFields(
  workspaceId: string,
  projectId: string,
  taskId: string,
  changes: { status?: TaskStatus; priority?: TaskPriority },
  expectedUpdatedAt: string,
): Promise<{ task: Task }> {
  return apiRequest(`${tasksPath(workspaceId, projectId)}/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: { ...changes, expectedUpdatedAt },
  });
}

export function updateTaskStatus(
  workspaceId: string,
  projectId: string,
  taskId: string,
  status: TaskStatus,
  expectedUpdatedAt: string,
): Promise<{ task: Task }> {
  return apiRequest(`${tasksPath(workspaceId, projectId)}/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: { status, expectedUpdatedAt },
  });
}

/**
 * PATCH (any member, active projects only): assigns the task to a member of
 * the same workspace, or unassigns it with `null`. `changed` is false when it
 * already had that assignee.
 */
export function setTaskAssignee(
  workspaceId: string,
  projectId: string,
  taskId: string,
  assigneeId: string | null,
): Promise<{ task: Task; changed: boolean }> {
  return apiRequest(`${tasksPath(workspaceId, projectId)}/${encodeURIComponent(taskId)}/assignee`, {
    method: 'PATCH',
    body: { assigneeId },
  });
}
