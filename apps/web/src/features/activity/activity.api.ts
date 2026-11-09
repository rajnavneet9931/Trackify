import { apiRequestEnvelope } from '../../lib/api-client';
import type { TaskPriority, TaskStatus } from '../tasks/tasks.api';

/** Someone mentioned in an entry: email only while they are a workspace member. */
export interface PersonRef {
  id: string;
  email: string | null;
}

export type ActivityDetails =
  | { type: 'TASK_CREATED'; priority: TaskPriority }
  | {
      type: 'TASK_UPDATED';
      changedFields: ('title' | 'description')[];
      title?: { from: string; to: string };
    }
  | { type: 'STATUS_CHANGED'; from: TaskStatus; to: TaskStatus }
  | { type: 'PRIORITY_CHANGED'; from: TaskPriority; to: TaskPriority }
  | {
      type: 'ASSIGNEE_CHANGED';
      from: PersonRef | null;
      to: PersonRef | null;
      reason?: 'MEMBER_REMOVED';
    }
  | { type: 'COMMENT_ADDED' | 'COMMENT_EDITED' | 'COMMENT_DELETED'; commentId: string }
  | { type: string; unavailable: true };

export interface TaskActivity {
  id: string;
  taskId: string;
  type: string;
  /** Null once the actor's account was deleted. */
  actorId: string | null;
  /** Null when the actor's account was deleted or they are no longer a member. */
  actor: { id: string; email: string } | null;
  details: ActivityDetails;
  createdAt: string;
}

export const ACTIVITY_PAGE_SIZE = 20;

/** GET (any member, read-only), oldest first. `nextCursor` is null on the last page. */
export async function listActivities(
  { workspaceId, projectId, taskId }: { workspaceId: string; projectId: string; taskId: string },
  { cursor, limit = ACTIVITY_PAGE_SIZE }: { cursor?: string | undefined; limit?: number } = {},
  signal?: AbortSignal,
): Promise<{ activities: TaskActivity[]; nextCursor: string | null }> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);

  const { data, meta } = await apiRequestEnvelope<
    { activities: TaskActivity[] },
    { nextCursor?: string | null }
  >(
    `/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/activities?${query}`,
    signal ? { signal } : {},
  );
  return { activities: data.activities, nextCursor: meta?.nextCursor ?? null };
}
