import { apiRequest } from '../../lib/api-client';
import type { TaskPriority, TaskStatus } from '../tasks/tasks.api';

export interface ProjectCompletion {
  id: string;
  name: string;
  totalTasks: number;
  doneTasks: number;
  /** Whole percent, rounded down; 0 for a project without tasks. */
  completionPercent: number;
}

export interface MyTask {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  project: { id: string; name: string };
}

export interface DashboardActivity {
  id: string;
  /** TASK_CREATED, STATUS_CHANGED, COMMENT_ADDED, … */
  type: string;
  createdAt: string;
  /** Null once the actor's account was deleted. */
  actorId: string | null;
  /** Null when the account was deleted or they are no longer a member. */
  actor: { id: string; email: string } | null;
  task: { id: string; title: string };
  project: { id: string; name: string };
}

/**
 * GET /workspaces/:id/dashboard. Task numbers cover active projects only;
 * "today" is the UTC day (`windows`) and "next 7 days" runs from now.
 */
export interface Dashboard {
  generatedAt: string;
  windows: { todayStart: string; todayEnd: string; weekEnd: string };
  tasks: {
    total: number;
    byStatus: Record<TaskStatus, number>;
    byPriority: Record<TaskPriority, number>;
    overdue: number;
    dueToday: number;
    dueNext7Days: number;
  };
  projects: { active: number; archived: number; completion: ProjectCompletion[] };
  myWork: {
    assigned: number;
    pending: number;
    overdue: number;
    upcoming: number;
    tasks: MyTask[];
  };
  recentActivity: DashboardActivity[];
}

export async function getDashboard(workspaceId: string, signal?: AbortSignal): Promise<Dashboard> {
  const { dashboard } = await apiRequest<{ dashboard: Dashboard }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/dashboard`,
    signal ? { signal } : {},
  );
  return dashboard;
}
