import type { Request, Response } from 'express';

import { sendSuccess } from '../../core/http/api-response.js';
import { getAuth } from '../sessions/index.js';
import type { WorkspaceParams } from '../workspaces/index.js';
import type { Dashboard, DashboardService } from './dashboard.service.js';

/** Response shape. Built field by field so nothing else can leak. */
function toDashboardResponse(d: Dashboard) {
  const { tasks, projects, myWork } = d;
  return {
    generatedAt: d.generatedAt.toISOString(),
    windows: {
      todayStart: d.bounds.todayStart.toISOString(),
      todayEnd: d.bounds.todayEnd.toISOString(),
      weekEnd: d.bounds.weekEnd.toISOString(),
    },
    tasks: {
      total: tasks.total,
      byStatus: { TODO: tasks.todo, IN_PROGRESS: tasks.inProgress, DONE: tasks.done },
      byPriority: {
        LOW: tasks.low,
        MEDIUM: tasks.medium,
        HIGH: tasks.high,
        URGENT: tasks.urgent,
      },
      overdue: tasks.overdue,
      dueToday: tasks.dueToday,
      dueNext7Days: tasks.dueNext7Days,
    },
    projects: {
      active: projects.active,
      archived: projects.archived,
      completion: projects.completion.map((p) => ({
        id: p.id,
        name: p.name,
        totalTasks: p.totalTasks,
        doneTasks: p.doneTasks,
        completionPercent: p.completionPercent,
      })),
    },
    myWork: {
      assigned: myWork.assigned,
      pending: myWork.pending,
      overdue: myWork.overdue,
      upcoming: myWork.upcoming,
      tasks: myWork.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        dueDate: t.dueDate?.toISOString() ?? null,
        project: { id: t.projectId, name: t.projectName },
      })),
    },
    recentActivity: d.recentActivity.map((a) => ({
      id: a.id,
      type: a.type,
      createdAt: a.createdAt.toISOString(),
      actorId: a.actorId,
      actor: a.actorId && a.actorEmail ? { id: a.actorId, email: a.actorEmail } : null,
      task: { id: a.taskId, title: a.taskTitle },
      project: { id: a.projectId, name: a.projectName },
    })),
  };
}

export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  get = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId } = req.params as WorkspaceParams;
    const dashboard = await this.service.get(workspaceId, getAuth(req).user.id);

    // Always fresh: no caching anywhere.
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, { dashboard: toDashboardResponse(dashboard) });
  };
}
