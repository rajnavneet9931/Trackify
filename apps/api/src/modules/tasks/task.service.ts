import {
  ConflictError,
  NotFoundError,
  UnprocessableEntityError,
  ValidationError,
} from '../../core/errors/app-error.js';
import { TaskActivityType, type ActivityInput } from '../activities/index.js';
import { taskAssigned } from '../notifications/index.js';
import { ProjectStatus } from '../projects/index.js';
import { authorizeMembership, WorkspaceRole, type WorkspaceAccess } from '../workspaces/index.js';
import {
  DEFAULT_TASK_SORT,
  decodeTaskListCursor,
  encodeTaskListCursor,
  sortValueOf,
  type TaskFilters,
  type TaskSort,
} from './task-query.js';
import { TaskStatus, type TaskDetail, type TaskView } from './task.model.js';
import type { NewTask, TaskChanges, TaskMutationScope, TaskRepository } from './task.repository.js';
import { scheduleProblem } from './task.validators.js';

export const TASK_MESSAGES = {
  projectNotFound: 'Project not found',
  taskNotFound: 'Task not found',
  archivedReadOnly: 'This project is archived. Its tasks are read-only until it is restored.',
  stale: 'This task was changed by someone else. Reload it to see the latest version.',
  // Same wording for unknown users and non-members: reveals no accounts.
  assigneeNotMember: 'The assignee must be a member of this workspace.',
} as const;

/** Result of an assignment: `changed: false` when it already had that assignee. */
export interface AssignmentResult {
  task: TaskView;
  changed: boolean;
}

/** Owners and members alike manage tasks. */
const ANY_MEMBER = [WorkspaceRole.OWNER, WorkspaceRole.MEMBER] as const;

export interface TaskPageInput {
  /** Authenticated user from the server-side session. */
  userId: string;
  limit: number;
  cursor?: string | undefined;
  filters?: TaskFilters | undefined;
  sort?: TaskSort | undefined;
}

export interface TaskPage {
  items: TaskView[];
  /** Opaque token for the next page (bound to project, sort and filters), or null. */
  nextCursor: string | null;
  /** Total matching tasks; only computed for the first page (no cursor). */
  total?: number | undefined;
}

export interface UpdateTaskInput extends TaskChanges {
  /** The `updatedAt` the client last saw (optimistic-concurrency precondition). */
  expectedUpdatedAt: Date;
}

/**
 * Tasks are managed by every workspace member (OWNER or MEMBER). Non-members
 * and unknown workspaces → 404 (WorkspaceAccess); a project outside the
 * workspace, or a task outside the project → 404. Archived projects are
 * readable, but their tasks cannot be created or edited (409).
 */
export class TaskService {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly access: WorkspaceAccess,
  ) {}

  /**
   * Creates the task, optionally with a status and an assignee, and records
   * its history in the same transaction: TASK_CREATED (with the status when
   * it isn't "To do"), plus ASSIGNEE_CHANGED and a notification to the
   * assignee (never to the requester) when one was chosen. The assignee's
   * membership is read FOR SHARE first (non-member or unknown → 422, nothing
   * created), exactly as for assignments.
   */
  create(workspaceId: string, projectId: string, userId: string, task: NewTask): Promise<TaskView> {
    return this.inWritableProject(workspaceId, projectId, userId, async (scope) => {
      const assigneeId = task.assigneeId ?? null;
      if (assigneeId !== null && !(await scope.isWorkspaceMember(assigneeId))) {
        throw new UnprocessableEntityError(TASK_MESSAGES.assigneeNotMember);
      }
      const created = await scope.create({ ...task, assigneeId });
      if (created.reminderAt) await scope.scheduleReminder(created.id, created.reminderAt);
      await scope.record(created.id, {
        type: TaskActivityType.TASK_CREATED,
        metadata: {
          priority: created.priority,
          ...(created.status !== TaskStatus.TODO && { status: created.status }),
          ...(created.dueDate && { dueDate: created.dueDate.toISOString() }),
        },
      });
      if (assigneeId !== null) {
        await scope.record(created.id, {
          type: TaskActivityType.ASSIGNEE_CHANGED,
          metadata: { from: null, to: assigneeId },
        });
        await scope.notify([
          taskAssigned({
            recipientId: assigneeId,
            taskId: created.id,
            taskTitle: created.title,
            reassigned: false,
            changedAt: created.updatedAt,
          }),
        ]);
      }
      return created;
    });
  }

  async list(
    workspaceId: string,
    projectId: string,
    { userId, limit, cursor, filters = {}, sort = DEFAULT_TASK_SORT }: TaskPageInput,
  ): Promise<TaskPage> {
    await this.requireReadableProject(workspaceId, projectId, userId);
    const now = new Date(); // one instant for the whole request (overdue)
    const after =
      cursor === undefined ? undefined : decodeTaskListCursor(cursor, projectId, sort, filters);
    const [rows, total] = await Promise.all([
      this.tasks.listForProject({
        projectId,
        take: limit + 1, // one extra row tells whether another page exists
        filters,
        sort,
        now,
        after,
      }),
      after ? undefined : this.tasks.countForProject(projectId, filters, now),
    ]);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? encodeTaskListCursor(projectId, sort, filters, {
              value: sortValueOf(last, sort.field),
              id: last.id,
            })
          : null,
      ...(total !== undefined && { total }),
    };
  }

  async get(
    workspaceId: string,
    projectId: string,
    taskId: string,
    userId: string,
  ): Promise<TaskDetail> {
    await this.requireReadableProject(workspaceId, projectId, userId);
    const task = await this.tasks.findInProject(workspaceId, projectId, taskId);
    if (!task) throw new NotFoundError(TASK_MESSAGES.taskNotFound);
    return task;
  }

  /**
   * Applies the changes only if the task still has the `updatedAt` the client
   * saw; otherwise 409 and nothing is written.
   */
  update(
    workspaceId: string,
    projectId: string,
    taskId: string,
    userId: string,
    { expectedUpdatedAt, ...changes }: UpdateTaskInput,
  ): Promise<TaskView> {
    return this.inWritableProject(workspaceId, projectId, userId, async (scope) => {
      // The row is locked, so `before` is exactly what this update replaces.
      const before = await scope.lock(taskId);
      if (!before) throw new NotFoundError(TASK_MESSAGES.taskNotFound);
      // The due date / reminder rules apply to the values the task will have.
      const dueDate = changes.dueDate !== undefined ? changes.dueDate : before.dueDate;
      const reminderAt = changes.reminderAt !== undefined ? changes.reminderAt : before.reminderAt;
      const problem = scheduleProblem(dueDate, reminderAt);
      if (problem) {
        throw new ValidationError([{ location: 'body', path: 'reminderAt', message: problem }]);
      }
      if (!(await scope.update(taskId, expectedUpdatedAt, changes))) {
        throw new ConflictError(TASK_MESSAGES.stale); // nothing written, nothing recorded
      }
      if (!sameInstant(before.reminderAt, reminderAt)) {
        await scope.scheduleReminder(taskId, reminderAt);
      }
      for (const activity of taskChangeActivities(before, changes)) {
        await scope.record(taskId, activity);
      }
      const current = await scope.find(taskId);
      if (!current) throw new NotFoundError(TASK_MESSAGES.taskNotFound);
      return current;
    });
  }

  /**
   * Any member assigns the task to a member of the same workspace, reassigns
   * it, or unassigns it (`null`). Order of checks: requester (404), project
   * (404, archived → 409), task (404), then the assignee's membership (422).
   * Concurrent assignments are serialized by the task row lock; the last one
   * wins and the result is always a current member or nobody. Idempotent:
   * the same assignee again → `changed: false`, nothing written.
   */
  assign(
    workspaceId: string,
    projectId: string,
    taskId: string,
    userId: string,
    assigneeId: string | null,
  ): Promise<AssignmentResult> {
    return this.inWritableProject(workspaceId, projectId, userId, async (scope) => {
      const before = await scope.lock(taskId);
      if (!before) throw new NotFoundError(TASK_MESSAGES.taskNotFound);
      if (assigneeId !== null && !(await scope.isWorkspaceMember(assigneeId))) {
        throw new UnprocessableEntityError(TASK_MESSAGES.assigneeNotMember);
      }
      const changed = await scope.setAssignee(taskId, assigneeId);
      if (changed) {
        await scope.record(taskId, {
          type: TaskActivityType.ASSIGNEE_CHANGED,
          metadata: { from: before.assigneeId, to: assigneeId },
        });
      }
      const task = await scope.find(taskId);
      if (!task) throw new NotFoundError(TASK_MESSAGES.taskNotFound);
      // The new assignee hears about it (never the requester assigning themselves).
      // Same transaction: if anything fails, neither the change nor the notification exists.
      if (changed && assigneeId !== null) {
        await scope.notify([
          taskAssigned({
            recipientId: assigneeId,
            taskId,
            taskTitle: task.title,
            reassigned: before.assigneeId !== null,
            changedAt: task.updatedAt,
          }),
        ]);
      }
      return { task, changed };
    });
  }

  /** Membership first (anti-enumeration), then the project within that workspace. */
  private async requireReadableProject(workspaceId: string, projectId: string, userId: string) {
    await this.access.requireMembership(workspaceId, userId);
    const status = await this.tasks.findProjectStatus(workspaceId, projectId);
    if (!status) throw new NotFoundError(TASK_MESSAGES.projectNotFound);
  }

  /**
   * Runs a task mutation with the requester's membership and the project's
   * status checked inside the same transaction (both rows read FOR SHARE).
   */
  private inWritableProject<T>(
    workspaceId: string,
    projectId: string,
    userId: string,
    fn: (scope: TaskMutationScope) => Promise<T>,
  ): Promise<T> {
    return this.tasks.withProjectLock(workspaceId, projectId, userId, (scope) => {
      authorizeMembership(scope.membership, ANY_MEMBER);
      if (!scope.projectStatus) throw new NotFoundError(TASK_MESSAGES.projectNotFound);
      if (scope.projectStatus === ProjectStatus.ARCHIVED) {
        throw new ConflictError(TASK_MESSAGES.archivedReadOnly);
      }
      return fn(scope);
    });
  }
}

/**
 * The activities an edit produces: one TASK_UPDATED for title/description
 * (title with its previous and new value; the description only as "changed",
 * never its text), plus STATUS_CHANGED and PRIORITY_CHANGED with previous and
 * new values. Fields that were sent but didn't actually change produce nothing.
 */
export function taskChangeActivities(before: TaskView, changes: TaskChanges): ActivityInput[] {
  const activities: ActivityInput[] = [];
  const titleChanged = changes.title !== undefined && changes.title !== before.title;
  const descriptionChanged =
    changes.description !== undefined && changes.description !== before.description;
  const dueDateChanged =
    changes.dueDate !== undefined && !sameInstant(changes.dueDate, before.dueDate);
  const reminderChanged =
    changes.reminderAt !== undefined && !sameInstant(changes.reminderAt, before.reminderAt);
  if (titleChanged || descriptionChanged || dueDateChanged || reminderChanged) {
    activities.push({
      type: TaskActivityType.TASK_UPDATED,
      metadata: {
        changedFields: [
          ...(titleChanged ? (['title'] as const) : []),
          ...(descriptionChanged ? (['description'] as const) : []),
          ...(dueDateChanged ? (['dueDate'] as const) : []),
          ...(reminderChanged ? (['reminderAt'] as const) : []),
        ],
        ...(titleChanged && { title: { from: before.title, to: changes.title! } }),
        ...(dueDateChanged && {
          dueDate: { from: iso(before.dueDate), to: iso(changes.dueDate ?? null) },
        }),
        ...(reminderChanged && {
          reminderAt: { from: iso(before.reminderAt), to: iso(changes.reminderAt ?? null) },
        }),
      },
    });
  }
  if (changes.status !== undefined && changes.status !== before.status) {
    activities.push({
      type: TaskActivityType.STATUS_CHANGED,
      metadata: { from: before.status, to: changes.status },
    });
  }
  if (changes.priority !== undefined && changes.priority !== before.priority) {
    activities.push({
      type: TaskActivityType.PRIORITY_CHANGED,
      metadata: { from: before.priority, to: changes.priority },
    });
  }
  return activities;
}

/** Whether two optional instants are the same (both unset, or equal to the millisecond). */
function sameInstant(a: Date | null, b: Date | null): boolean {
  return a === null || b === null ? a === b : a.getTime() === b.getTime();
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);
