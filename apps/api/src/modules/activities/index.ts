import type { RequestHandler, Router } from 'express';

import type { DatabaseClient } from '../../infrastructure/database/prisma.js';
import {
  PrismaWorkspaceRepository,
  WorkspaceAccess,
  type WorkspaceRepository,
} from '../workspaces/index.js';
import { ActivityController } from './activity.controller.js';
import { PrismaActivityRepository, type ActivityRepository } from './activity.repository.js';
import { createActivityRouter } from './activity.routes.js';
import { ActivityService } from './activity.service.js';

// Public API of the activities module.
export { recordTaskActivities, recordTaskActivity } from './activity-writer.js';
export { TaskActivityType, type ActivityInput, type ActivityRecord } from './activity.model.js';
export {
  PrismaActivityRepository,
  type ActivityPageQuery,
  type ActivityRepository,
} from './activity.repository.js';

export interface ActivityModuleDeps {
  db: DatabaseClient;
  requireSession: RequestHandler;
  /** Overrides for tests. Default to the Prisma-backed implementations. */
  repository?: ActivityRepository | undefined;
  workspaceRepository?: WorkspaceRepository | undefined;
}

/** Composition root for the activities module: repository → service → controller → router. */
export function createActivityModule({
  db,
  requireSession,
  repository,
  workspaceRepository,
}: ActivityModuleDeps): Router {
  const service = new ActivityService(
    repository ?? new PrismaActivityRepository(db),
    new WorkspaceAccess(workspaceRepository ?? new PrismaWorkspaceRepository(db)),
  );
  return createActivityRouter(new ActivityController(service), { requireSession });
}
