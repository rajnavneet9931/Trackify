import type { WorkspaceAccess } from '../workspaces/index.js';
import type {
  DashboardBounds,
  DashboardData,
  MyTaskRow,
  RecentActivityRow,
} from './dashboard.model.js';
import type { DashboardRepository } from './dashboard.repository.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ProjectCompletion {
  id: string;
  name: string;
  totalTasks: number;
  doneTasks: number;
  /** Whole percent, rounded down (100 only when every task is done); 0 without tasks. */
  completionPercent: number;
}

export interface Dashboard {
  generatedAt: Date;
  /** The UTC windows the counts were computed with. */
  bounds: DashboardBounds;
  tasks: DashboardData['tasks'];
  projects: DashboardData['projects'] & { completion: ProjectCompletion[] };
  myWork: DashboardData['myWork'] & { tasks: MyTaskRow[] };
  recentActivity: RecentActivityRow[];
}

/** The UTC windows for `now`: today is the UTC calendar day, the week is now + 7 days. */
export function dashboardBounds(now: Date): DashboardBounds {
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return {
    now,
    todayStart,
    todayEnd: new Date(todayStart.getTime() + DAY_MS),
    weekEnd: new Date(now.getTime() + 7 * DAY_MS),
  };
}

export function completionPercent(doneTasks: number, totalTasks: number): number {
  return totalTasks === 0 ? 0 : Math.floor((doneTasks * 100) / totalTasks);
}

/**
 * Workspace dashboard for any member (OWNER or MEMBER). Non-members and
 * unknown workspaces → 404. Read-only; nothing is cached.
 */
export class DashboardService {
  constructor(
    private readonly dashboards: DashboardRepository,
    private readonly access: WorkspaceAccess,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async get(workspaceId: string, userId: string): Promise<Dashboard> {
    await this.access.requireMembership(workspaceId, userId);
    const now = this.clock();
    const bounds = dashboardBounds(now);
    const data = await this.dashboards.load(workspaceId, userId, bounds);
    return {
      generatedAt: now,
      bounds,
      tasks: data.tasks,
      projects: {
        ...data.projects,
        completion: data.projectCompletion.map((p) => ({
          ...p,
          completionPercent: completionPercent(p.doneTasks, p.totalTasks),
        })),
      },
      myWork: { ...data.myWork, tasks: data.myTasks },
      recentActivity: data.recentActivity,
    };
  }
}
