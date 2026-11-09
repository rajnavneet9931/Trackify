import type { DatabaseClient } from '../../infrastructure/database/prisma.js';
import { mutedNotificationTypes } from '../account/index.js';
import {
  NotificationResourceType,
  type NotificationType,
  type NotificationCursor,
  type NotificationTarget,
  type NotificationView,
} from './notification.model.js';

export interface NotificationPageQuery {
  take: number;
  unreadOnly: boolean;
  /** Continue strictly after this position (exclusive). */
  after?: NotificationCursor | undefined;
}

/**
 * The recipient's own notifications. Every method is scoped in the query to
 * `recipient_id = userId` **and** to workspaces the user still belongs to:
 * anything else (another user's, or from a workspace they left) behaves as if
 * it did not exist.
 */
export interface NotificationRepository {
  /** Newest first. */
  listForUser(userId: string, query: NotificationPageQuery): Promise<NotificationView[]>;
  countUnread(userId: string): Promise<number>;
  /** Idempotent (keeps the first read time); null if not the user's. */
  markRead(userId: string, id: string): Promise<NotificationView | null>;
  /** Returns how many were marked. */
  markAllRead(userId: string): Promise<number>;
  /** False if not the user's (or already deleted). */
  delete(userId: string, id: string): Promise<boolean>;
}

/**
 * Ownership and membership, enforced in every WHERE clause, minus the types
 * the user turned off in their settings (those are hidden, not deleted).
 */
const visibleTo = (userId: string, muted: NotificationType[]) => ({
  recipientId: userId,
  workspace: { members: { some: { userId } } },
  ...(muted.length > 0 && { type: { notIn: muted } }),
});

const select = {
  id: true,
  workspaceId: true,
  type: true,
  title: true,
  message: true,
  resourceType: true,
  resourceId: true,
  actorId: true,
  isRead: true,
  readAt: true,
  createdAt: true,
} as const;

type Row = Omit<NotificationView, 'actor' | 'target'>;

export class PrismaNotificationRepository implements NotificationRepository {
  constructor(private readonly db: DatabaseClient) {}

  async listForUser(userId: string, { take, unreadOnly, after }: NotificationPageQuery) {
    const muted = await this.muted(userId);
    // Served by notifications_inbox_idx, or notifications_unread_idx when unread only.
    const rows = await this.db.notification.findMany({
      where: {
        ...visibleTo(userId, muted),
        ...(unreadOnly && { isRead: false }),
        ...(after && {
          OR: [
            { createdAt: { lt: after.createdAt } },
            { createdAt: after.createdAt, id: { lt: after.id } },
          ],
        }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select,
    });
    return this.decorate(rows);
  }

  async countUnread(userId: string) {
    const muted = await this.muted(userId);
    return this.db.notification.count({ where: { ...visibleTo(userId, muted), isRead: false } });
  }

  async markRead(userId: string, id: string) {
    const muted = await this.muted(userId);
    // Conditional: only the user's own, only if still unread (keeps the first read time).
    await this.db.notification.updateMany({
      where: { id, ...visibleTo(userId, muted), isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    const row = await this.db.notification.findFirst({
      where: { id, ...visibleTo(userId, muted) },
      select,
    });
    return row ? ((await this.decorate([row]))[0] ?? null) : null;
  }

  async markAllRead(userId: string) {
    const muted = await this.muted(userId);
    const { count } = await this.db.notification.updateMany({
      where: { ...visibleTo(userId, muted), isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return count;
  }

  async delete(userId: string, id: string) {
    const muted = await this.muted(userId);
    const { count } = await this.db.notification.deleteMany({
      where: { id, ...visibleTo(userId, muted) },
    });
    return count === 1;
  }

  /** The types this user turned off (one indexed lookup by primary key). */
  private async muted(userId: string): Promise<NotificationType[]> {
    return [...((await mutedNotificationTypes(this.db, [userId])).get(userId) ?? [])];
  }

  /**
   * Adds the actor (email only while a member) and the navigation target,
   * checking that the task or project still exists in that workspace. A fixed
   * three lookups per page, never one per notification.
   */
  private async decorate(rows: Row[]): Promise<NotificationView[]> {
    if (rows.length === 0) return [];
    const ids = (type: NotificationResourceType) => [
      ...new Set(rows.filter((r) => r.resourceType === type).map((r) => r.resourceId)),
    ];
    const actorIds = [...new Set(rows.flatMap((r) => (r.actorId ? [r.actorId] : [])))];
    const workspaceIds = [...new Set(rows.map((r) => r.workspaceId))];

    const [tasks, projects, actors] = await Promise.all([
      this.db.task.findMany({
        where: { id: { in: ids(NotificationResourceType.TASK) } },
        select: { id: true, projectId: true, project: { select: { workspaceId: true } } },
      }),
      this.db.project.findMany({
        where: { id: { in: ids(NotificationResourceType.PROJECT) } },
        select: { id: true, workspaceId: true },
      }),
      actorIds.length === 0
        ? []
        : this.db.workspaceMember.findMany({
            where: { workspaceId: { in: workspaceIds }, userId: { in: actorIds } },
            select: { workspaceId: true, user: { select: { id: true, email: true } } },
          }),
    ]);
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const actorEmail = new Map(actors.map((m) => [`${m.workspaceId}|${m.user.id}`, m.user.email]));

    return rows.map((row) => {
      let target: NotificationTarget | null = null;
      if (row.resourceType === NotificationResourceType.TASK) {
        const t = taskById.get(row.resourceId);
        if (t && t.project.workspaceId === row.workspaceId) {
          target = { workspaceId: row.workspaceId, projectId: t.projectId, taskId: t.id };
        }
      } else if (row.resourceType === NotificationResourceType.PROJECT) {
        const p = projectById.get(row.resourceId);
        if (p && p.workspaceId === row.workspaceId) {
          target = { workspaceId: row.workspaceId, projectId: p.id, taskId: null };
        }
      } else if (row.resourceId === row.workspaceId) {
        target = { workspaceId: row.workspaceId, projectId: null, taskId: null };
      }
      const email = row.actorId ? actorEmail.get(`${row.workspaceId}|${row.actorId}`) : undefined;
      return {
        ...row,
        actor: row.actorId && email ? { id: row.actorId, email } : null,
        target,
      };
    });
  }
}
