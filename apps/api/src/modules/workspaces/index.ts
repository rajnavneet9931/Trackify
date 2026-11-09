import type { RequestHandler, Router } from 'express';

import type { DatabaseClient } from '../../infrastructure/database/prisma.js';
import { WorkspaceAccess } from './workspace-access.js';
import { WorkspaceController } from './workspace.controller.js';
import { PrismaWorkspaceRepository, type WorkspaceRepository } from './workspace.repository.js';
import { createWorkspaceRouter } from './workspace.routes.js';
import { WorkspaceService } from './workspace.service.js';

// Public API of the workspaces module.
export { WorkspaceAccess, authorizeMembership } from './workspace-access.js';
export { workspaceParamsSchema, type WorkspaceParams } from './workspace.validators.js';
export {
  WorkspaceRole,
  type Membership,
  type WorkspaceListItem,
  type WorkspaceSettings,
  type WorkspaceSettingsChanges,
  type WorkspaceSummary,
} from './workspace.model.js';
export {
  PrismaWorkspaceRepository,
  type LockedWorkspace,
  type MemberPageQuery,
  type MembershipPageQuery,
  type WorkspaceListRow,
  type WorkspaceMemberRow,
  type WorkspaceRepository,
} from './workspace.repository.js';

export interface WorkspaceModuleDeps {
  db: DatabaseClient;
  requireSession: RequestHandler;
  /** Override for tests. Defaults to the Prisma-backed implementation. */
  repository?: WorkspaceRepository | undefined;
}

/** Composition root for the workspaces module: repository → service → controller → router. */
export function createWorkspaceModule({
  db,
  requireSession,
  repository,
}: WorkspaceModuleDeps): Router {
  const workspaces = repository ?? new PrismaWorkspaceRepository(db);
  const service = new WorkspaceService(workspaces, new WorkspaceAccess(workspaces));
  return createWorkspaceRouter(new WorkspaceController(service), { requireSession });
}
