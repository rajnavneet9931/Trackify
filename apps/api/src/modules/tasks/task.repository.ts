import { Prisma } from '../../generated/prisma/client.js';
import type { DatabaseClient } from '../../infrastructure/database/prisma.js';
import { recordTaskActivity, type ActivityInput } from '../activities/index.js';
import { createNotifications, type NotificationInput } from '../notifications/index.js';
import type { ProjectStatus } from '../projects/index.js';
import type { Membership } from '../workspaces/index.js';
import {
  taskListAfter,
  taskListOrderBy,
  taskListWhere,
  type TaskFilters,
  type TaskPosition,
  type TaskSort,
} from './task-query.js';
import {
  TaskStatus,
  taskViewSelect,
  type TaskDetail,
  type TaskPriority,
  type TaskView,
} from './task.model.js';

export interface NewTask {
  title: string;
  description: string | null;
  priority: TaskPriority;
  /** Defaults to TODO when omitted. */
  status?: TaskStatus | undefined;
  /** Must already be verified as a workspace member (in this transaction). */
  assigneeId?: string | null | undefined;
  dueDate: Date | null;
  reminderAt: Date | null;
}

/** Fields that may change. `undefined` = leave unchanged; `null` clears the description. */
export interface TaskChanges {
  title?: string | undefined;
  description?: string | null | undefined;
  status?: TaskStatus | undefined;
  priority?: TaskPriority | undefined;
  /** `null` clears the due date. */
  dueDate?: Date | null | undefined;
  /** `null` clears the reminder. */
  reminderAt?: Date | null | undefined;
}

export interface TaskPageQuery {
  projectId: string;
  take: number;
  filters: TaskFilters;
  sort: TaskSort;
  /** "Now", for the overdue filter (one instant per request). */
  now: Date;
  /** Continue strictly after this position (exclusive). */
  after?: TaskPosition | undefined;
}

/**
 * Task operations inside one transaction, all scoped to the one project (which
 * was itself looked up within the requested workspace).
 */
export interface TaskMutationScope {
  /** The requester's membership, read FOR SHARE: it cannot change until commit. */
  membership: Membership | null;
  /** The project's status if it belongs to the workspace (row read FOR SHARE), else null. */
  projectStatus: ProjectStatus | null;
  /** Inserts a TODO task in this project, created by the requester. */
  create(task: NewTask): Promise<TaskView>;
  find(taskId: string): Promise<TaskView | null>;
  /** Only if the task's updated_at equals `expectedUpdatedAt`. False otherwise. */
  update(taskId: string, expectedUpdatedAt: Date, changes: TaskChanges): Promise<boolean>;
  /** Locks a task of this project FOR UPDATE until commit and returns it; null if absent. */
  lock(taskId: string): Promise<TaskView | null>;
  /** Records an activity by the requester in this same transaction. */
  record(taskId: string, activity: ActivityInput): Promise<void>;
  /**
   * Creates notifications from the requester in this same transaction (never
   * to the requester, once per recipient and event, only to current members).
   */
  notify(notifications: NotificationInput[]): Promise<void>;
  /** Whether this user is a member of the workspace (row read FOR SHARE until commit). */
  isWorkspaceMember(userId: string): Promise<boolean>;
  /** Sets (or clears, with null) the assignee. False if missing or already that value. */
  setAssignee(taskId: string, assigneeId: string | null): Promise<boolean>;
  /**
   * Cancels the task's pending reminder (if any) and, when `remindAt` is set,
   * schedules a new one, in this same transaction.
   */
  scheduleReminder(taskId: string, remindAt: Date | null): Promise<void>;
}

export interface TaskRepository {
  /** The status of a project of this workspace, or null. Callers must authorize first. */
  findProjectStatus(workspaceId: string, projectId: string): Promise<ProjectStatus | null>;
  /** One page of a project's tasks, newest first. Callers must authorize and scope first. */
  listForProject(query: TaskPageQuery): Promise<TaskView[]>;
  /** How many of the project's tasks match the filters. Callers must authorize and scope first. */
  countForProject(projectId: string, filters: TaskFilters, now: Date): Promise<number>;
  /** One task of this project with its creator, or null. Callers must authorize and scope first. */
  findInProject(workspaceId: string, projectId: string, taskId: string): Promise<TaskDetail | null>;
  /**
   * Runs `fn` in one transaction that first reads, FOR SHARE, the requester's
   * membership and the project (scoped to the workspace). A concurrent removal
   * or role change of the requester, and a concurrent archive, restore or
   * delete of the project, therefore wait until this transaction commits (or
   * this one waits and sees their result): a task is never created in, or
   * edited after, a project that was archived or deleted meanwhile.
   */
  withProjectLock<T>(
    workspaceId: string,
    projectId: string,
    userId: string,
    fn: (scope: TaskMutationScope) => Promise<T>,
  ): Promise<T>;
}

const LOCK_TIMEOUT = '5s';
const TX_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;

/** updated_at moves strictly forward on every edit (see the projects repository). */
const BUMP_UPDATED_AT = Prisma.sql`updated_at = GREATEST(date_trunc('milliseconds', clock_timestamp()), updated_at + interval '1 millisecond')`;

export class PrismaTaskRepository implements TaskRepository {
  constructor(private readonly db: DatabaseClient) {}

  async findProjectStatus(workspaceId: string, projectId: string) {
    const project = await this.db.project.findFirst({
      where: { id: projectId, workspaceId },
      select: { status: true },
    });
    return project?.status ?? null;
  }

  listForProject({
    projectId,
    take,
    filters,
    sort,
    now,
    after,
  }: TaskPageQuery): Promise<TaskView[]> {
    // One statement, always scoped to the project (project_id index); the
    // default sort is served by tasks_project_id_created_at_id_idx. Keyset
    // pagination on (sort value, id): never offsets.
    const where = taskListWhere(projectId, filters, now);
    return this.db.task.findMany({
      where: after ? { AND: [where, taskListAfter(sort, after)] } : where,
      orderBy: taskListOrderBy(sort),
      take,
      select: taskViewSelect,
    });
  }

  countForProject(projectId: string, filters: TaskFilters, now: Date): Promise<number> {
    return this.db.task.count({ where: taskListWhere(projectId, filters, now) });
  }

  async findInProject(
    workspaceId: string,
    projectId: string,
    taskId: string,
  ): Promise<TaskDetail | null> {
    // Scoped by task, project and workspace in one query. The creator's email
    // is shown only while they are a member of this workspace.
    const row = await this.db.task.findFirst({
      where: { id: taskId, projectId, project: { workspaceId } },
      select: {
        ...taskViewSelect,
        createdBy: {
          select: {
            id: true,
            email: true,
            memberships: { where: { workspaceId }, select: { id: true }, take: 1 },
          },
        },
        // The latest reminder only, for its delivery state.
        reminders: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: { status: true, remindAt: true, sentAt: true },
        },
      },
    });
    if (!row) return null;
    const { createdBy, reminders, ...task } = row;
    return {
      ...task,
      creator:
        createdBy.memberships.length > 0 ? { id: createdBy.id, email: createdBy.email } : null,
      reminder: reminders[0] ?? null,
    };
  }

  withProjectLock<T>(
    workspaceId: string,
    projectId: string,
    userId: string,
    fn: (scope: TaskMutationScope) => Promise<T>,
  ): Promise<T> {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      // Always membership first, then project: the same order as the project
      // mutations, so the two kinds of transaction cannot deadlock.
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

      return fn({
        membership: membership ? { workspaceId, userId, role: membership.role } : null,
        projectStatus: project?.status ?? null,
        create: ({ title, description, priority, status, assigneeId, dueDate, reminderAt }) =>
          tx.task.create({
            // Every column set explicitly from validated, server-side values.
            data: {
              projectId,
              createdById: userId,
              title,
              description,
              priority,
              dueDate,
              reminderAt,
              status: status ?? TaskStatus.TODO,
              assigneeId: assigneeId ?? null,
            },
            select: taskViewSelect,
          }),
        find: (taskId) =>
          tx.task.findFirst({ where: { id: taskId, projectId }, select: taskViewSelect }),
        lock: async (taskId) => {
          // Row lock first, so the values read are exactly those the update replaces.
          const [locked] = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM tasks
            WHERE id = ${taskId}::uuid AND project_id = ${projectId}::uuid
            FOR UPDATE`;
          return locked
            ? tx.task.findFirst({ where: { id: taskId, projectId }, select: taskViewSelect })
            : null;
        },
        record: (taskId, activity) => recordTaskActivity(tx, taskId, userId, activity),
        notify: async (notifications) => {
          await createNotifications(tx, { workspaceId, actorId: userId }, notifications);
        },
        update: async (
          taskId,
          expectedUpdatedAt,
          { title, description, status, priority, dueDate, reminderAt },
        ) => {
          const sets = [BUMP_UPDATED_AT];
          if (title !== undefined) sets.push(Prisma.sql`title = ${title}`);
          if (description !== undefined) sets.push(Prisma.sql`description = ${description}`);
          if (status !== undefined) sets.push(Prisma.sql`status = ${status}::task_status`);
          if (priority !== undefined) sets.push(Prisma.sql`priority = ${priority}::task_priority`);
          if (dueDate !== undefined) sets.push(Prisma.sql`due_date = ${dueDate}::timestamptz`);
          if (reminderAt !== undefined) {
            sets.push(Prisma.sql`reminder_at = ${reminderAt}::timestamptz`);
          }
          const count = await tx.$executeRaw`
            UPDATE tasks SET ${Prisma.join(sets)}
            WHERE id = ${taskId}::uuid AND project_id = ${projectId}::uuid
              AND updated_at = ${expectedUpdatedAt.toISOString()}::timestamptz`;
          return count === 1;
        },
        isWorkspaceMember: async (candidateId) => {
          // FOR SHARE: a concurrent removal of this member (DELETE) waits for
          // this transaction, then unassigns them, so no assignment to a
          // non-member can survive. Taken after the requester and project
          // locks, matching the order used everywhere else.
          const rows = await tx.$queryRaw<unknown[]>`
            SELECT 1 FROM workspace_members
            WHERE workspace_id = ${workspaceId}::uuid AND user_id = ${candidateId}::uuid
            FOR SHARE`;
          return rows.length === 1;
        },
        scheduleReminder: async (taskId, remindAt) => {
          await tx.taskReminder.updateMany({
            where: { taskId, status: 'PENDING' },
            data: { status: 'CANCELLED', lastError: 'Replaced by a newer reminder' },
          });
          if (remindAt) {
            await tx.taskReminder.create({ data: { taskId, remindAt }, select: { id: true } });
          }
        },
        setAssignee: async (taskId, assigneeId) => {
          // Writes (and bumps updated_at) only when the assignee actually changes.
          const count = await tx.$executeRaw`
            UPDATE tasks SET assignee_id = ${assigneeId}::uuid, ${BUMP_UPDATED_AT}
            WHERE id = ${taskId}::uuid AND project_id = ${projectId}::uuid
              AND assignee_id IS DISTINCT FROM ${assigneeId}::uuid`;
          return count === 1;
        },
      });
    }, TX_OPTIONS);
  }
}
