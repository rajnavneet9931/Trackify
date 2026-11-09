import { NotFoundError } from '../../core/errors/app-error.js';
import type { WorkspaceAccess } from '../workspaces/index.js';
import { decodeActivityCursor, encodeActivityCursor } from './activity-cursor.js';
import { TaskActivityType, type ActivityRecord } from './activity.model.js';
import type { ActivityRepository } from './activity.repository.js';

/** A user mentioned in an activity: email only while they are a member of the workspace. */
export interface PersonRef {
  id: string;
  email: string | null;
}

/** Safe, display-ready details per type. Never comment text or other sensitive data. */
export type ActivityDetails =
  | { type: 'TASK_CREATED'; priority: string; dueDate?: string }
  | {
      type: 'TASK_UPDATED';
      changedFields: string[];
      title?: { from: string; to: string };
      dueDate?: { from: string | null; to: string | null };
      reminderAt?: { from: string | null; to: string | null };
    }
  | { type: 'STATUS_CHANGED' | 'PRIORITY_CHANGED'; from: string; to: string }
  | {
      type: 'ASSIGNEE_CHANGED';
      from: PersonRef | null;
      to: PersonRef | null;
      reason?: 'MEMBER_REMOVED';
    }
  | { type: 'COMMENT_ADDED' | 'COMMENT_EDITED' | 'COMMENT_DELETED'; commentId: string }
  /** Stored metadata didn't validate: shown without details rather than leaked. */
  | { type: TaskActivityType; unavailable: true };

export interface ActivityView {
  id: string;
  taskId: string;
  type: TaskActivityType;
  /** Null once the actor's account was deleted. */
  actorId: string | null;
  /** Null when the actor's account was deleted or they are no longer a member. */
  actor: { id: string; email: string } | null;
  details: ActivityDetails;
  createdAt: Date;
}

export interface ActivityPage {
  items: ActivityView[];
  nextCursor: string | null;
}

/**
 * Read-only task history for every member of the workspace (archived
 * projects included). Non-members and unknown workspaces → 404; a project or
 * task outside its parent → 404.
 */
export class ActivityService {
  constructor(
    private readonly activities: ActivityRepository,
    private readonly access: WorkspaceAccess,
  ) {}

  async list(
    workspaceId: string,
    projectId: string,
    taskId: string,
    { userId, limit, cursor }: { userId: string; limit: number; cursor?: string | undefined },
  ): Promise<ActivityPage> {
    await this.access.requireMembership(workspaceId, userId);
    if (!(await this.activities.taskExists(workspaceId, projectId, taskId))) {
      throw new NotFoundError('Task not found');
    }
    const rows = await this.activities.listForTask({
      taskId,
      take: limit + 1, // one extra row tells whether another page exists
      after: cursor === undefined ? undefined : decodeActivityCursor(cursor, taskId),
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);

    // One lookup for every person on the page: actors and assignees.
    const people = new Set<string>();
    for (const row of page) {
      if (row.actorId) people.add(row.actorId);
      if (row.type === TaskActivityType.ASSIGNEE_CHANGED && row.metadata) {
        const { from, to } = row.metadata as { from: string | null; to: string | null };
        if (from) people.add(from);
        if (to) people.add(to);
      }
    }
    const emails = await this.activities.memberEmails(workspaceId, [...people]);
    const person = (id: string | null): PersonRef | null =>
      id === null ? null : { id, email: emails.get(id) ?? null };

    return {
      items: page.map((row) => ({
        id: row.id,
        taskId: row.taskId,
        type: row.type,
        actorId: row.actorId,
        actor:
          row.actorId && emails.has(row.actorId)
            ? { id: row.actorId, email: emails.get(row.actorId)! }
            : null,
        details: toDetails(row, person),
        createdAt: row.createdAt,
      })),
      nextCursor: rows.length > limit && last ? encodeActivityCursor(taskId, last) : null,
    };
  }
}

function toDetails(
  { type, metadata }: ActivityRecord,
  person: (id: string | null) => PersonRef | null,
): ActivityDetails {
  if (!metadata) return { type, unavailable: true };
  const m = metadata as Record<string, unknown>;
  switch (type) {
    case TaskActivityType.TASK_CREATED:
      return {
        type,
        priority: m.priority as string,
        ...(m.dueDate ? { dueDate: m.dueDate as string } : {}),
      };
    case TaskActivityType.TASK_UPDATED:
      return {
        type,
        changedFields: m.changedFields as string[],
        ...(m.title ? { title: m.title as { from: string; to: string } } : {}),
        ...(m.dueDate ? { dueDate: m.dueDate as { from: string | null; to: string | null } } : {}),
        ...(m.reminderAt
          ? { reminderAt: m.reminderAt as { from: string | null; to: string | null } }
          : {}),
      };
    case TaskActivityType.STATUS_CHANGED:
    case TaskActivityType.PRIORITY_CHANGED:
      return { type, from: m.from as string, to: m.to as string };
    case TaskActivityType.ASSIGNEE_CHANGED:
      return {
        type,
        from: person(m.from as string | null),
        to: person(m.to as string | null),
        ...(m.reason ? { reason: 'MEMBER_REMOVED' as const } : {}),
      };
    default:
      return { type, commentId: m.commentId as string };
  }
}
