import { ConflictError, ForbiddenError, NotFoundError } from '../../core/errors/app-error.js';
import { TaskActivityType } from '../activities/index.js';
import { taskCommented } from '../notifications/index.js';
import { ProjectStatus } from '../projects/index.js';
import { authorizeMembership, WorkspaceRole, type WorkspaceAccess } from '../workspaces/index.js';
import { decodeCommentCursor, encodeCommentCursor } from './comment-cursor.js';
import type { CommentView } from './comment.model.js';
import type { CommentMutationScope, CommentRepository } from './comment.repository.js';

export const COMMENT_MESSAGES = {
  projectNotFound: 'Project not found',
  taskNotFound: 'Task not found',
  commentNotFound: 'Comment not found',
  archivedReadOnly: 'This project is archived. Its discussion is read-only until it is restored.',
  notYourComment: 'You can only edit your own comments.',
  cannotDelete: 'You can only delete your own comments.',
  stale: 'This comment was changed meanwhile. Reload the discussion to see the latest version.',
} as const;

/** Owners and members alike take part in discussions. */
const ANY_MEMBER = [WorkspaceRole.OWNER, WorkspaceRole.MEMBER] as const;

export interface CommentPageInput {
  /** Authenticated user from the server-side session. */
  userId: string;
  limit: number;
  cursor?: string | undefined;
}

export interface CommentPage {
  items: CommentView[];
  /** Opaque, task-bound token for the next page, or null on the last page. */
  nextCursor: string | null;
}

interface Target {
  workspaceId: string;
  projectId: string;
  taskId: string;
}

/**
 * Task discussions. Every member can read and post; authors edit their own
 * comments; authors and workspace owners delete. Archived projects are
 * readable but their discussion is read-only (409). Non-members and unknown
 * workspaces → 404; a project, task or comment outside its parent → 404.
 */
export class CommentService {
  constructor(
    private readonly comments: CommentRepository,
    private readonly access: WorkspaceAccess,
  ) {}

  create(target: Target, userId: string, content: string): Promise<CommentView> {
    return this.inWritableTask(target, userId, async (scope) => {
      const comment = await scope.create(content);
      // Only the comment ID: the activity history never stores comment text.
      await scope.record({
        type: TaskActivityType.COMMENT_ADDED,
        metadata: { commentId: comment.id },
      });
      // The assignee, and the creator unless they are the assignee: one each,
      // never the commenter (the writer drops self-notifications and duplicates).
      const task = scope.task!;
      const about = { taskId: target.taskId, taskTitle: task.title, commentId: comment.id };
      await scope.notify([
        ...(task.assigneeId
          ? [taskCommented({ ...about, recipientId: task.assigneeId, as: 'assignee' as const })]
          : []),
        ...(task.createdById !== task.assigneeId
          ? [taskCommented({ ...about, recipientId: task.createdById, as: 'creator' as const })]
          : []),
      ]);
      return comment;
    });
  }

  async list(
    { workspaceId, projectId, taskId }: Target,
    { userId, limit, cursor }: CommentPageInput,
  ): Promise<CommentPage> {
    await this.access.requireMembership(workspaceId, userId);
    if (!(await this.comments.taskExists(workspaceId, projectId, taskId))) {
      throw new NotFoundError(COMMENT_MESSAGES.taskNotFound);
    }
    const rows = await this.comments.listForTask({
      workspaceId,
      taskId,
      take: limit + 1, // one extra row tells whether another page exists
      after: cursor === undefined ? undefined : decodeCommentCursor(cursor, taskId),
    });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? encodeCommentCursor(taskId, last) : null,
    };
  }

  /**
   * Only the author edits (owners included: 403 on someone else's comment),
   * and only if the comment still has the `updatedAt` the client saw (409).
   */
  update(
    target: Target,
    commentId: string,
    userId: string,
    { content, expectedUpdatedAt }: { content: string; expectedUpdatedAt: Date },
  ): Promise<CommentView> {
    return this.inWritableTask(target, userId, async (scope) => {
      const locked = await scope.lock(commentId);
      if (!locked) throw new NotFoundError(COMMENT_MESSAGES.commentNotFound);
      if (locked.authorId !== userId) throw new ForbiddenError(COMMENT_MESSAGES.notYourComment);
      if (!(await scope.update(commentId, expectedUpdatedAt, content))) {
        throw new ConflictError(COMMENT_MESSAGES.stale);
      }
      if (content !== locked.content) {
        await scope.record({ type: TaskActivityType.COMMENT_EDITED, metadata: { commentId } });
      }
      const updated = await scope.find(commentId);
      if (!updated) throw new NotFoundError(COMMENT_MESSAGES.commentNotFound);
      return updated;
    });
  }

  /** The author, or an OWNER of the workspace, deletes. A repeat finds nothing (404). */
  delete(target: Target, commentId: string, userId: string): Promise<void> {
    return this.inWritableTask(target, userId, async (scope) => {
      const locked = await scope.lock(commentId);
      if (!locked) throw new NotFoundError(COMMENT_MESSAGES.commentNotFound);
      const isOwner = scope.membership?.role === WorkspaceRole.OWNER;
      if (locked.authorId !== userId && !isOwner) {
        throw new ForbiddenError(COMMENT_MESSAGES.cannotDelete);
      }
      if (!(await scope.delete(commentId))) {
        throw new NotFoundError(COMMENT_MESSAGES.commentNotFound);
      }
      await scope.record({ type: TaskActivityType.COMMENT_DELETED, metadata: { commentId } });
    });
  }

  /**
   * Runs a mutation with the requester's membership, the project's status and
   * the task's place in the hierarchy checked inside the same transaction.
   */
  private inWritableTask<T>(
    { workspaceId, projectId, taskId }: Target,
    userId: string,
    fn: (scope: CommentMutationScope) => Promise<T>,
  ): Promise<T> {
    return this.comments.withTaskLock(workspaceId, projectId, taskId, userId, (scope) => {
      authorizeMembership(scope.membership, ANY_MEMBER);
      if (!scope.projectStatus) throw new NotFoundError(COMMENT_MESSAGES.projectNotFound);
      if (!scope.taskExists) throw new NotFoundError(COMMENT_MESSAGES.taskNotFound);
      if (scope.projectStatus === ProjectStatus.ARCHIVED) {
        throw new ConflictError(COMMENT_MESSAGES.archivedReadOnly);
      }
      return fn(scope);
    });
  }
}
