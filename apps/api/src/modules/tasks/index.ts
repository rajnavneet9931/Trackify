import type { RequestHandler, Router } from 'express';

import type { DatabaseClient } from '../../infrastructure/database/prisma.js';
import {
  PrismaWorkspaceRepository,
  WorkspaceAccess,
  type WorkspaceRepository,
} from '../workspaces/index.js';
import { TaskController } from './task.controller.js';
import { PrismaTaskRepository, type TaskRepository } from './task.repository.js';
import { createTaskRouter } from './task.routes.js';
import { TaskService } from './task.service.js';

// Public API of the tasks module.
export { TaskPriority, TaskStatus, type TaskDetail, type TaskView } from './task.model.js';
export {
  PrismaTaskRepository,
  type NewTask,
  type TaskChanges,
  type TaskMutationScope,
  type TaskPageQuery,
  type TaskRepository,
} from './task.repository.js';

export interface TaskModuleDeps {
  db: DatabaseClient;
  requireSession: RequestHandler;
  /** Overrides for tests. Default to the Prisma-backed implementations. */
  repository?: TaskRepository | undefined;
  workspaceRepository?: WorkspaceRepository | undefined;
}

/** Composition root for the tasks module: repository → service → controller → router. */
export function createTaskModule({
  db,
  requireSession,
  repository,
  workspaceRepository,
}: TaskModuleDeps): Router {
  const service = new TaskService(
    repository ?? new PrismaTaskRepository(db),
    new WorkspaceAccess(workspaceRepository ?? new PrismaWorkspaceRepository(db)),
  );
  return createTaskRouter(new TaskController(service), { requireSession });
}
