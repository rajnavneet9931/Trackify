import type { Request, Response } from 'express';

import { sendSuccess } from '../../core/http/api-response.js';
import { getAuth } from '../sessions/index.js';
import type { TaskView } from './task.model.js';
import type { TaskService } from './task.service.js';
import type {
  AssignTaskBody,
  CreateTaskBody,
  ListTasksQuery,
  ProjectTasksParams,
  TaskParams,
  UpdateTaskBody,
} from './task.validators.js';

/** Response shape for a task. Built field by field so nothing else can leak. */
function toTaskResponse(task: TaskView) {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    createdById: task.createdById,
    assigneeId: task.assigneeId,
    assignee: task.assignee && { id: task.assignee.id, email: task.assignee.email },
    dueDate: task.dueDate?.toISOString() ?? null,
    reminderAt: task.reminderAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

export class TaskController {
  constructor(private readonly service: TaskService) {}

  /** Creator from the session, project from the URL, status always TODO. */
  create = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, projectId } = req.params as ProjectTasksParams;
    const { title, description, priority, status, assigneeId, dueDate, reminderAt } =
      req.body as CreateTaskBody;
    const task = await this.service.create(workspaceId, projectId, getAuth(req).user.id, {
      title,
      description,
      priority,
      status,
      assigneeId,
      dueDate,
      reminderAt,
    });
    sendSuccess(res, { task: toTaskResponse(task) }, 201);
  };

  list = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, projectId } = req.params as ProjectTasksParams;
    const { limit, cursor, sortBy, sortOrder, ...filters } = req.query as unknown as ListTasksQuery;
    const page = await this.service.list(workspaceId, projectId, {
      userId: getAuth(req).user.id,
      limit,
      cursor,
      filters,
      sort: { field: sortBy, order: sortOrder },
    });

    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, { tasks: page.items.map(toTaskResponse) }, 200, {
      limit,
      nextCursor: page.nextCursor,
      // Total matching tasks, on the first page only (not recomputed while paging).
      ...(page.total !== undefined && { total: page.total }),
    });
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, projectId, taskId } = req.params as TaskParams;
    const { creator, reminder, ...task } = await this.service.get(
      workspaceId,
      projectId,
      taskId,
      getAuth(req).user.id,
    );

    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, {
      task: toTaskResponse(task),
      // Only id and email, and only while the creator is a member of this workspace.
      creator: creator && { id: creator.id, email: creator.email },
      // Delivery state of the latest reminder (in-app), if one was ever scheduled.
      reminder: reminder && {
        status: reminder.status,
        remindAt: reminder.remindAt.toISOString(),
        sentAt: reminder.sentAt?.toISOString() ?? null,
      },
    });
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, projectId, taskId } = req.params as TaskParams;
    const body = req.body as UpdateTaskBody;
    const task = await this.service.update(
      workspaceId,
      projectId,
      taskId,
      getAuth(req).user.id,
      body,
    );
    sendSuccess(res, { task: toTaskResponse(task) });
  };

  /** Assignee only from the validated body; workspace, project and task only from the URL. */
  assign = async (req: Request, res: Response): Promise<void> => {
    const { workspaceId, projectId, taskId } = req.params as TaskParams;
    const { assigneeId } = req.body as AssignTaskBody;
    const result = await this.service.assign(
      workspaceId,
      projectId,
      taskId,
      getAuth(req).user.id,
      assigneeId,
    );
    sendSuccess(res, { task: toTaskResponse(result.task), changed: result.changed });
  };
}
