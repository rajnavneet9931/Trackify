import type { TaskActivityType } from '../activities/index.js';

/** Recent activity entries on the dashboard. */
export const RECENT_ACTIVITY_LIMIT = 10;
/** Active projects listed with their completion (newest first). */
export const PROJECT_COMPLETION_LIMIT = 50;
/** Open tasks listed under "My work" (soonest due first). */
export const MY_TASKS_LIMIT = 5;

/** Time windows, all in UTC. "Today" is the UTC calendar day containing `now`. */
export interface DashboardBounds {
  now: Date;
  todayStart: Date;
  todayEnd: Date;
  /** `now` + 7 days: the end of "due in the next 7 days" / "upcoming". */
  weekEnd: Date;
}

/** Task counts over the workspace's active projects. */
export interface TaskCounts {
  total: number;
  todo: number;
  inProgress: number;
  done: number;
  low: number;
  medium: number;
  high: number;
  urgent: number;
  /** Not DONE and due before now. */
  overdue: number;
  /** Not DONE and due during today (UTC). */
  dueToday: number;
  /** Not DONE and due from now until now + 7 days. */
  dueNext7Days: number;
}

/** The requester's assigned tasks over the workspace's active projects. */
export interface MyWorkCounts {
  assigned: number;
  /** Assigned and not DONE. */
  pending: number;
  /** Assigned, not DONE, due before now. */
  overdue: number;
  /** Assigned, not DONE, due from now until now + 7 days. */
  upcoming: number;
}

export interface ProjectCompletionRow {
  id: string;
  name: string;
  totalTasks: number;
  doneTasks: number;
}

export interface MyTaskRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate: Date | null;
  projectId: string;
  projectName: string;
}

export interface RecentActivityRow {
  id: string;
  type: TaskActivityType;
  createdAt: Date;
  actorId: string | null;
  /** Only while the actor is a member of the workspace. */
  actorEmail: string | null;
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
}

/** Everything the dashboard shows, read from one consistent snapshot. */
export interface DashboardData {
  tasks: TaskCounts;
  myWork: MyWorkCounts;
  projects: { active: number; archived: number };
  projectCompletion: ProjectCompletionRow[];
  myTasks: MyTaskRow[];
  recentActivity: RecentActivityRow[];
}
