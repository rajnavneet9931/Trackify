import { apiRequest, apiRequestEnvelope } from '../../lib/api-client';

export interface TaskComment {
  id: string;
  taskId: string;
  authorId: string;
  /** Only while the author is still a member of the workspace; otherwise null. */
  author: { id: string; email: string } | null;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export const COMMENT_PAGE_SIZE = 20;
export const COMMENT_MAX_LENGTH = 5000;

const commentsPath = (workspaceId: string, projectId: string, taskId: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/comments`;

export interface CommentTarget {
  workspaceId: string;
  projectId: string;
  taskId: string;
}

/** GET (any member), oldest first. `nextCursor` is null on the last page. */
export async function listComments(
  { workspaceId, projectId, taskId }: CommentTarget,
  { cursor, limit = COMMENT_PAGE_SIZE }: { cursor?: string | undefined; limit?: number } = {},
  signal?: AbortSignal,
): Promise<{ comments: TaskComment[]; nextCursor: string | null }> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);

  const { data, meta } = await apiRequestEnvelope<
    { comments: TaskComment[] },
    { nextCursor?: string | null }
  >(`${commentsPath(workspaceId, projectId, taskId)}?${query}`, signal ? { signal } : {});
  return { comments: data.comments, nextCursor: meta?.nextCursor ?? null };
}

/** POST (any member, active projects only). The author is always the signed-in user. */
export function createComment(
  { workspaceId, projectId, taskId }: CommentTarget,
  content: string,
): Promise<{ comment: TaskComment }> {
  return apiRequest(commentsPath(workspaceId, projectId, taskId), {
    method: 'POST',
    body: { content },
  });
}

/** PATCH (author only). 409 if the comment changed since `expectedUpdatedAt`. */
export function updateComment(
  { workspaceId, projectId, taskId }: CommentTarget,
  commentId: string,
  input: { content: string; expectedUpdatedAt: string },
): Promise<{ comment: TaskComment }> {
  return apiRequest(
    `${commentsPath(workspaceId, projectId, taskId)}/${encodeURIComponent(commentId)}`,
    { method: 'PATCH', body: input },
  );
}

/** DELETE (author, or a workspace owner). */
export function deleteComment(
  { workspaceId, projectId, taskId }: CommentTarget,
  commentId: string,
): Promise<{ deleted: true }> {
  return apiRequest(
    `${commentsPath(workspaceId, projectId, taskId)}/${encodeURIComponent(commentId)}`,
    { method: 'DELETE' },
  );
}
