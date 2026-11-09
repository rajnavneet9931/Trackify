import type { DatabaseClient } from '../../infrastructure/database/prisma.js';
import type { TaskActivityType } from '../activities/index.js';
import {
  MY_TASKS_LIMIT,
  PROJECT_COMPLETION_LIMIT,
  RECENT_ACTIVITY_LIMIT,
  type DashboardBounds,
  type DashboardData,
  type MyWorkCounts,
  type TaskCounts,
} from './dashboard.model.js';

/** Both count groups come back as one row; the requester's overdue count is renamed. */
type CountsRow = TaskCounts & Omit<MyWorkCounts, 'overdue'> & { myOverdue: number };

/** Read-only aggregation for one workspace. Callers must authorize first. */
export interface DashboardRepository {
  load(workspaceId: string, userId: string, bounds: DashboardBounds): Promise<DashboardData>;
}

export class PrismaDashboardRepository implements DashboardRepository {
  constructor(private readonly db: DatabaseClient) {}

  async load(workspaceId: string, userId: string, bounds: DashboardBounds): Promise<DashboardData> {
    const now = bounds.now.toISOString();
    const todayStart = bounds.todayStart.toISOString();
    const todayEnd = bounds.todayEnd.toISOString();
    const weekEnd = bounds.weekEnd.toISOString();

    // Five aggregate statements in one REPEATABLE READ transaction, so every
    // number comes from the same snapshot (e.g. total = TODO + IN_PROGRESS + DONE).
    // A fixed number of statements however many projects or tasks: no N+1.
    const [[counts], [projects], completion, myTasks, activity] = await this.db.$transaction(
      [
        // Task overview and my work, over active projects only (archived ones are read-only).
        this.db.$queryRaw<CountsRow[]>`
          SELECT
            count(*)::int AS "total",
            count(*) FILTER (WHERE t.status = 'TODO'::task_status)::int AS "todo",
            count(*) FILTER (WHERE t.status = 'IN_PROGRESS'::task_status)::int AS "inProgress",
            count(*) FILTER (WHERE t.status = 'DONE'::task_status)::int AS "done",
            count(*) FILTER (WHERE t.priority = 'LOW'::task_priority)::int AS "low",
            count(*) FILTER (WHERE t.priority = 'MEDIUM'::task_priority)::int AS "medium",
            count(*) FILTER (WHERE t.priority = 'HIGH'::task_priority)::int AS "high",
            count(*) FILTER (WHERE t.priority = 'URGENT'::task_priority)::int AS "urgent",
            count(*) FILTER (WHERE t.status <> 'DONE'::task_status
              AND t.due_date < ${now}::timestamptz)::int AS "overdue",
            count(*) FILTER (WHERE t.status <> 'DONE'::task_status
              AND t.due_date >= ${todayStart}::timestamptz
              AND t.due_date < ${todayEnd}::timestamptz)::int AS "dueToday",
            count(*) FILTER (WHERE t.status <> 'DONE'::task_status
              AND t.due_date >= ${now}::timestamptz
              AND t.due_date < ${weekEnd}::timestamptz)::int AS "dueNext7Days",
            count(*) FILTER (WHERE t.assignee_id = ${userId}::uuid)::int AS "assigned",
            count(*) FILTER (WHERE t.assignee_id = ${userId}::uuid
              AND t.status <> 'DONE'::task_status)::int AS "pending",
            count(*) FILTER (WHERE t.assignee_id = ${userId}::uuid
              AND t.status <> 'DONE'::task_status
              AND t.due_date < ${now}::timestamptz)::int AS "myOverdue",
            count(*) FILTER (WHERE t.assignee_id = ${userId}::uuid
              AND t.status <> 'DONE'::task_status
              AND t.due_date >= ${now}::timestamptz
              AND t.due_date < ${weekEnd}::timestamptz)::int AS "upcoming"
          FROM tasks t
          JOIN projects p ON p.id = t.project_id
          WHERE p.workspace_id = ${workspaceId}::uuid
            AND p.status = 'ACTIVE'::project_status`,
        this.db.$queryRaw<{ active: number; archived: number }[]>`
          SELECT
            count(*) FILTER (WHERE status = 'ACTIVE'::project_status)::int AS "active",
            count(*) FILTER (WHERE status = 'ARCHIVED'::project_status)::int AS "archived"
          FROM projects
          WHERE workspace_id = ${workspaceId}::uuid`,
        // Completion per active project; LEFT JOIN keeps projects without tasks.
        this.db.$queryRaw<{ id: string; name: string; totalTasks: number; doneTasks: number }[]>`
          SELECT p.id, p.name,
                 count(t.id)::int AS "totalTasks",
                 count(t.id) FILTER (WHERE t.status = 'DONE'::task_status)::int AS "doneTasks"
          FROM projects p
          LEFT JOIN tasks t ON t.project_id = p.id
          WHERE p.workspace_id = ${workspaceId}::uuid
            AND p.status = 'ACTIVE'::project_status
          GROUP BY p.id
          ORDER BY p.created_at DESC, p.id DESC
          LIMIT ${PROJECT_COMPLETION_LIMIT}`,
        // The requester's open tasks, soonest due first (undated last).
        this.db.$queryRaw<
          {
            id: string;
            title: string;
            status: string;
            priority: string;
            dueDate: Date | null;
            projectId: string;
            projectName: string;
          }[]
        >`
          SELECT t.id, t.title, t.status::text AS "status", t.priority::text AS "priority",
                 t.due_date AS "dueDate", p.id AS "projectId", p.name AS "projectName"
          FROM tasks t
          JOIN projects p ON p.id = t.project_id
          WHERE p.workspace_id = ${workspaceId}::uuid
            AND p.status = 'ACTIVE'::project_status
            AND t.assignee_id = ${userId}::uuid
            AND t.status <> 'DONE'::task_status
          ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC, t.id DESC
          LIMIT ${MY_TASKS_LIMIT}`,
        // Latest activity across the workspace (archived projects included).
        // The actor's email only while they are still a member.
        this.db.$queryRaw<
          {
            id: string;
            type: TaskActivityType;
            createdAt: Date;
            actorId: string | null;
            actorEmail: string | null;
            taskId: string;
            taskTitle: string;
            projectId: string;
            projectName: string;
          }[]
        >`
          SELECT a.id, a.type::text AS "type", a.created_at AS "createdAt",
                 a.user_id AS "actorId", u.email AS "actorEmail",
                 t.id AS "taskId", t.title AS "taskTitle",
                 p.id AS "projectId", p.name AS "projectName"
          FROM task_activities a
          JOIN tasks t ON t.id = a.task_id
          JOIN projects p ON p.id = t.project_id
          LEFT JOIN workspace_members m
            ON m.workspace_id = p.workspace_id AND m.user_id = a.user_id
          LEFT JOIN users u ON u.id = m.user_id
          WHERE p.workspace_id = ${workspaceId}::uuid
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT ${RECENT_ACTIVITY_LIMIT}`,
      ],
      { isolationLevel: 'RepeatableRead' },
    );

    const c = counts!;
    return {
      tasks: {
        total: c.total,
        todo: c.todo,
        inProgress: c.inProgress,
        done: c.done,
        low: c.low,
        medium: c.medium,
        high: c.high,
        urgent: c.urgent,
        overdue: c.overdue,
        dueToday: c.dueToday,
        dueNext7Days: c.dueNext7Days,
      },
      myWork: {
        assigned: c.assigned,
        pending: c.pending,
        overdue: c.myOverdue,
        upcoming: c.upcoming,
      },
      projects: { active: projects!.active, archived: projects!.archived },
      projectCompletion: completion,
      myTasks,
      recentActivity: activity,
    };
  }
}
