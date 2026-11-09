import type { RequestHandler, Router } from 'express';

import type { DatabaseClient } from '../../infrastructure/database/prisma.js';
import {
  PrismaWorkspaceRepository,
  WorkspaceAccess,
  type WorkspaceRepository,
} from '../workspaces/index.js';
import { DashboardController } from './dashboard.controller.js';
import { PrismaDashboardRepository, type DashboardRepository } from './dashboard.repository.js';
import { createDashboardRouter } from './dashboard.routes.js';
import { DashboardService } from './dashboard.service.js';

// Public API of the dashboard module.
export type {
  DashboardBounds,
  DashboardData,
  MyTaskRow,
  ProjectCompletionRow,
  RecentActivityRow,
} from './dashboard.model.js';
export { PrismaDashboardRepository, type DashboardRepository } from './dashboard.repository.js';

export interface DashboardModuleDeps {
  db: DatabaseClient;
  requireSession: RequestHandler;
  /** Overrides for tests. Default to the Prisma-backed implementations. */
  repository?: DashboardRepository | undefined;
  workspaceRepository?: WorkspaceRepository | undefined;
}

/** Composition root for the dashboard module: repository → service → controller → router. */
export function createDashboardModule({
  db,
  requireSession,
  repository,
  workspaceRepository,
}: DashboardModuleDeps): Router {
  const service = new DashboardService(
    repository ?? new PrismaDashboardRepository(db),
    new WorkspaceAccess(workspaceRepository ?? new PrismaWorkspaceRepository(db)),
  );
  return createDashboardRouter(new DashboardController(service), { requireSession });
}
