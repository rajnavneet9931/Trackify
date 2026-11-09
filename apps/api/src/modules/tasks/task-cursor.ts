import { DEFAULT_TASK_SORT, encodeTaskListCursor } from './task-query.js';

/**
 * A cursor for the default task list (created_at DESC, id DESC, no filters),
 * in the current query-bound format (see task-query.ts). Kept for callers
 * that only need the default listing.
 */
export function encodeTaskCursor(
  projectId: string,
  { createdAt, id }: { createdAt: Date; id: string },
): string {
  return encodeTaskListCursor(
    projectId,
    DEFAULT_TASK_SORT,
    {},
    {
      value: createdAt.toISOString(),
      id,
    },
  );
}
