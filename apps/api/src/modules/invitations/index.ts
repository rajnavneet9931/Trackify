import type { Request, RequestHandler, Router } from 'express';

import type { AppConfig } from '../../config/env.js';
import { createRateLimiter } from '../../core/middleware/rate-limit.js';
import type { DatabaseClient } from '../../infrastructure/database/prisma.js';
import { PrismaUserRepository, type UserDirectory } from '../users/index.js';
import {
  PrismaWorkspaceRepository,
  WorkspaceAccess,
  type WorkspaceRepository,
} from '../workspaces/index.js';
import { InvitationController } from './invitation.controller.js';
import { PrismaInvitationRepository, type InvitationRepository } from './invitation.repository.js';
import {
  createInvitationResponseRouter,
  createWorkspaceInvitationsRouter,
} from './invitation.routes.js';
import { InvitationService } from './invitation.service.js';

// Public API of the invitations module.
export { InvitationStatus, type InvitationView } from './invitation.model.js';
export {
  PrismaInvitationRepository,
  type InvitationForToken,
  type InvitationRepository,
  type NewInvitation,
} from './invitation.repository.js';

export interface InvitationModuleDeps {
  db: DatabaseClient;
  config: AppConfig;
  requireSession: RequestHandler;
  /** Overrides for tests. Default to the Prisma-backed implementations. */
  repository?: InvitationRepository | undefined;
  workspaceRepository?: WorkspaceRepository | undefined;
  userDirectory?: UserDirectory | undefined;
}

/** Per-user bucket (the route runs after authentication). */
function invitingUserKey(req: Request): string {
  return `invite:${req.auth?.user.id ?? 'anonymous'}`;
}

/** Composition root: repositories → service → controller → two routers. */
export function createInvitationModule({
  db,
  config,
  requireSession,
  repository,
  workspaceRepository,
  userDirectory,
}: InvitationModuleDeps): { workspaceInvitations: Router; invitationResponses: Router } {
  const workspaces = workspaceRepository ?? new PrismaWorkspaceRepository(db);
  const service = new InvitationService(
    repository ?? new PrismaInvitationRepository(db),
    new WorkspaceAccess(workspaces),
    workspaces,
    userDirectory ?? new PrismaUserRepository(db),
    config.invitations.ttlMs,
  );
  const controller = new InvitationController(service, config.invitations.exposeDevLinks);

  return {
    workspaceInvitations: createWorkspaceInvitationsRouter(controller, {
      requireSession,
      createLimit: createRateLimiter({
        ...config.invitations.createRateLimit,
        keyGenerator: invitingUserKey,
      }),
    }),
    invitationResponses: createInvitationResponseRouter(controller, { requireSession }),
  };
}
