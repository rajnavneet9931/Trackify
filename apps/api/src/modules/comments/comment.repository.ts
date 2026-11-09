import type { DatabaseClient } from '../../infrastructure/database/prisma.js';
import { recordTaskActivity, type ActivityInput } from '../activities/index.js';
import { createNotifications, type NotificationInput } from '../notifications/index.js';
import type { ProjectStatus } from '../projects/index.js';
import type { Membership } from '../workspaces/index.js';
import type { CommentCursor } from './comment-cursor.js';
import { commentSelect, toCommentView, type CommentView } from './comment.model.js';

export interface CommentPageQuery {
  workspaceId: string;
  taskId: string;
  take: number;
  /** Continue strictly after this position (exclusive). */
  after?: CommentCursor | undefined;
}

/** A comment row locked FOR UPDATE: who wrote it, and its current version. */
export interface LockedComment {
  authorId: string;
  content: string;
  updatedAt: Date;
}

/**
 * Comment operations inside one transaction, scoped to one task (which was
 * looked up within the project, which was looked up within the workspace).
 */
export interface CommentMutationScope {
  /** The requester's membership, read FOR SHARE: it cannot change until commit. */
  membership: Membership | null;
  /** The project's status if it belongs to the workspace (row read FOR SHARE), else null. */
  projectStatus: ProjectStatus | null;
  /** Whether the task belongs to that project. */
  taskExists: boolean;
  /** The task's title and the people a comment notifies; null if absent. */
  task: { title: string; assigneeId: string | null; createdById: string } | null;
  /** Inserts a comment by the requester. */
  create(content: string): Promise<CommentView>;
  /** Locks a comment of this task FOR UPDATE until commit; null if absent. */
  lock(commentId: string): Promise<LockedComment | null>;
  find(commentId: string): Promise<CommentView | null>;
  /** Only the requester's own comment, only at `expectedUpdatedAt`. False otherwise. */
  update(commentId: string, expectedUpdatedAt: Date, content: string): Promise<boolean>;
  /** Deletes exactly this comment of this task. False if absent. */
  delete(commentId: string): Promise<boolean>;
  /** Records an activity on this task by the requester, in this same transaction. */
  record(activity: ActivityInput): Promise<void>;
  /**
   * Creates notifications from the requester in this same transaction (never
   * to the requester, once per recipient and event, only to current members).
   */
  notify(notifications: NotificationInput[]): Promise<void>;
}

export interface CommentRepository {
  /** Whether the task belongs to the project, and the project to the workspace. */
  taskExists(workspaceId: string, projectId: string, taskId: string): Promise<boolean>;
  /** One page of a task's comments, oldest first. Callers must authorize and scope first. */
  listForTask(query: CommentPageQuery): Promise<CommentView[]>;
  /**
   * Runs `fn` in one transaction that first reads, FOR SHARE, the requester's
   * membership and then the project (scoped to the workspace), and checks the
   * task belongs to the project. Concurrent removals, role changes, archives
   * and project deletions therefore cannot interleave with the mutation.
   */
  withTaskLock<T>(
    workspaceId: string,
    projectId: string,
    taskId: string,
    userId: string,
    fn: (scope: CommentMutationScope) => Promise<T>,
  ): Promise<T>;
}

const LOCK_TIMEOUT = '5s';
const TX_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;

export class PrismaCommentRepository implements CommentRepository {
  constructor(private readonly db: DatabaseClient) {}

  async taskExists(workspaceId: string, projectId: string, taskId: string) {
    const task = await this.db.task.findFirst({
      where: { id: taskId, projectId, project: { workspaceId } },
      select: { id: true },
    });
    return task !== null;
  }

  async listForTask({ workspaceId, taskId, take, after }: CommentPageQuery) {
    // One statement, served by task_comments_task_id_created_at_id_idx.
    const rows = await this.db.taskComment.findMany({
      where: {
        taskId,
        ...(after && {
          OR: [
            { createdAt: { gt: after.createdAt } },
            { createdAt: after.createdAt, id: { gt: after.id } },
          ],
        }),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take,
      select: commentSelect(workspaceId),
    });
    return rows.map(toCommentView);
  }

  withTaskLock<T>(
    workspaceId: string,
    projectId: string,
    taskId: string,
    userId: string,
    fn: (scope: CommentMutationScope) => Promise<T>,
  ): Promise<T> {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      // Same lock order as project and task mutations: membership, then project.
      const [membership] = await tx.$queryRaw<{ role: Membership['role'] }[]>`
        SELECT role FROM workspace_members
        WHERE workspace_id = ${workspaceId}::uuid AND user_id = ${userId}::uuid
        FOR SHARE`;
      const [project] = membership
        ? await tx.$queryRaw<{ status: ProjectStatus }[]>`
            SELECT status FROM projects
            WHERE id = ${projectId}::uuid AND workspace_id = ${workspaceId}::uuid
            FOR SHARE`
        : [];
      const task = project
        ? await tx.task.findFirst({
            where: { id: taskId, projectId },
            select: { title: true, assigneeId: true, createdById: true },
          })
        : null;
      const select = commentSelect(workspaceId);

      return fn({
        membership: membership ? { workspaceId, userId, role: membership.role } : null,
        projectStatus: project?.status ?? null,
        taskExists: task !== null,
        task,
        notify: async (notifications) => {
          await createNotifications(tx, { workspaceId, actorId: userId }, notifications);
        },
        create: async (content) =>
          toCommentView(await tx.taskComment.create({ data: { taskId, userId, content }, select })),
        lock: async (commentId) => {
          const [row] = await tx.$queryRaw<
            { user_id: string; content: string; updated_at: Date }[]
          >`
            SELECT user_id, content, updated_at FROM task_comments
            WHERE id = ${commentId}::uuid AND task_id = ${taskId}::uuid
            FOR UPDATE`;
          return row
            ? { authorId: row.user_id, content: row.content, updatedAt: row.updated_at }
            : null;
        },
        find: async (commentId) => {
          const row = await tx.taskComment.findFirst({ where: { id: commentId, taskId }, select });
          return row ? toCommentView(row) : null;
        },
        update: async (commentId, expectedUpdatedAt, content) => {
          // updated_at always moves strictly forward (see the projects repository).
          const count = await tx.$executeRaw`
            UPDATE task_comments
            SET content = ${content},
                updated_at = GREATEST(date_trunc('milliseconds', clock_timestamp()), updated_at + interval '1 millisecond')
            WHERE id = ${commentId}::uuid AND task_id = ${taskId}::uuid
              AND user_id = ${userId}::uuid
              AND updated_at = ${expectedUpdatedAt.toISOString()}::timestamptz`;
          return count === 1;
        },
        delete: async (commentId) => {
          const { count } = await tx.taskComment.deleteMany({ where: { id: commentId, taskId } });
          return count === 1;
        },
        record: (activity) => recordTaskActivity(tx, taskId, userId, activity),
      });
    }, TX_OPTIONS);
  }
}
