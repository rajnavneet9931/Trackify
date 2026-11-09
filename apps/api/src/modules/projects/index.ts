import type { RequestHandler, Router } from 'express';

import type { DatabaseClient } from '../../infrastructure/database/prisma.js';
import {
  PrismaWorkspaceRepository,
  WorkspaceAccess,
  type WorkspaceRepository,
} from '../workspaces/index.js';
import { ProjectController } from './project.controller.js';
import { PrismaProjectRepository, type ProjectRepository } from './project.repository.js';
import { createProjectRouter } from './project.routes.js';
import { ProjectService } from './project.service.js';

// Public API of the projects module.
export { ProjectStatus, type ProjectDetail, type ProjectView } from './project.model.js';
export {
  PrismaProjectRepository,
  type NewProject,
  type ProjectChanges,
  type ProjectDeletion,
  type ProjectMutationScope,
  type ProjectPageQuery,
  type ProjectRepository,
} from './project.repository.js';

export interface ProjectModuleDeps {
  db: DatabaseClient;
  requireSession: RequestHandler;
  /** Overrides for tests. Default to the Prisma-backed implementations. */
  repository?: ProjectRepository | undefined;
  workspaceRepository?: WorkspaceRepository | undefined;
}

/** Composition root for the projects module: repository → service → controller → router. */
export function createProjectModule({
  db,
  requireSession,
  repository,
  workspaceRepository,
}: ProjectModuleDeps): Router {
  const service = new ProjectService(
    repository ?? new PrismaProjectRepository(db),
    new WorkspaceAccess(workspaceRepository ?? new PrismaWorkspaceRepository(db)),
  );
  return createProjectRouter(new ProjectController(service), { requireSession });
}
