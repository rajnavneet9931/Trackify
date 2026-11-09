import type { DatabaseClient } from '../../infrastructure/database/prisma.js';
import type { ActivityCursor } from './activity-cursor.js';
import { parseStoredMetadata, type ActivityRecord } from './activity.model.js';

export interface ActivityPageQuery {
  taskId: string;
  take: number;
  /** Continue strictly after this position (exclusive). */
  after?: ActivityCursor | undefined;
}

/** Read-only: activities are written only by recordTaskActivity, inside other transactions. */
export interface ActivityRepository {
  /** Whether the task belongs to the project, and the project to the workspace. */
  taskExists(workspaceId: string, projectId: string, taskId: string): Promise<boolean>;
  /** One page of a task's activities, oldest first. Callers must authorize and scope first. */
  listForTask(query: ActivityPageQuery): Promise<ActivityRecord[]>;
  /**
   * Emails of those of `userIds` who are currently members of the workspace.
   * Anyone else (removed members, deleted accounts) is simply absent.
   */
  memberEmails(workspaceId: string, userIds: string[]): Promise<Map<string, string>>;
}

export class PrismaActivityRepository implements ActivityRepository {
  constructor(private readonly db: DatabaseClient) {}

  async taskExists(workspaceId: string, projectId: string, taskId: string) {
    const task = await this.db.task.findFirst({
      where: { id: taskId, projectId, project: { workspaceId } },
      select: { id: true },
    });
    return task !== null;
  }

  async listForTask({ taskId, take, after }: ActivityPageQuery): Promise<ActivityRecord[]> {
    // One statement, served by task_activities_task_id_created_at_id_idx.
    const rows = await this.db.taskActivity.findMany({
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
      select: { id: true, taskId: true, userId: true, type: true, metadata: true, createdAt: true },
    });
    return rows.map(({ userId, metadata, ...row }) => ({
      ...row,
      actorId: userId,
      metadata: parseStoredMetadata(row.type, metadata),
    }));
  }

  async memberEmails(workspaceId: string, userIds: string[]) {
    if (userIds.length === 0) return new Map<string, string>();
    // One query for a whole page (no N+1); only id and email ever leave here.
    const rows = await this.db.workspaceMember.findMany({
      where: { workspaceId, userId: { in: userIds } },
      select: { user: { select: { id: true, email: true } } },
    });
    return new Map(rows.map(({ user }) => [user.id, user.email]));
  }
}
