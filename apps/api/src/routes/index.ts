import { Router } from 'express';

import type { AppConfig } from '../config/env.js';
import type { Logger } from '../config/logger.js';
import type { DatabaseClient } from '../infrastructure/database/prisma.js';
import { createAccountModule, type AccountRepository } from '../modules/account/index.js';
import { createAuthModule } from '../modules/auth/index.js';
import type { HealthRepository } from '../modules/health/health.repository.js';
import { createHealthModule } from '../modules/health/index.js';
import {
  PrismaSessionRepository,
  requireSession,
  SessionService,
  type SessionRepository,
} from '../modules/sessions/index.js';
import { createInvitationModule, type InvitationRepository } from '../modules/invitations/index.js';
import { createProjectModule, type ProjectRepository } from '../modules/projects/index.js';
import { createTaskModule, type TaskRepository } from '../modules/tasks/index.js';
import { createCommentModule, type CommentRepository } from '../modules/comments/index.js';
import { createActivityModule, type ActivityRepository } from '../modules/activities/index.js';
import { createDashboardModule, type DashboardRepository } from '../modules/dashboard/index.js';
import {
  createNotificationModule,
  type NotificationRepository,
} from '../modules/notifications/index.js';
import type { UserDirectory, UserRepository } from '../modules/users/index.js';
import { createWorkspaceModule, type WorkspaceRepository } from '../modules/workspaces/index.js';

export interface ApiRouterDeps {
  config: AppConfig;
  logger: Logger;
  db: DatabaseClient;
  overrides?:
    | {
        healthRepository?: HealthRepository;
        userRepository?: UserRepository;
        sessionRepository?: SessionRepository;
        workspaceRepository?: WorkspaceRepository;
        invitationRepository?: InvitationRepository;
        userDirectory?: UserDirectory;
        projectRepository?: ProjectRepository;
        taskRepository?: TaskRepository;
        commentRepository?: CommentRepository;
        activityRepository?: ActivityRepository;
        notificationRepository?: NotificationRepository;
        dashboardRepository?: DashboardRepository;
        accountRepository?: AccountRepository;
      }
    | undefined;
}

/**
 * Versioned API router. Each feature module exposes a factory and is mounted
 * here under its own path; modules never import each other's internals.
 */
export function createApiRouter({ config, logger, db, overrides }: ApiRouterDeps): Router {
  const router = Router();

  // One session service and one guard (authentication + CSRF) for every module.
  const sessions = new SessionService(
    overrides?.sessionRepository ?? new PrismaSessionRepository(db),
    config.auth.session.ttlMs,
  );
  const sessionGuard = requireSession(sessions, config.auth.session.cookie);

  router.use(
    '/health',
    createHealthModule({
      db,
      logger,
      dbTimeoutMs: config.health.dbTimeoutMs,
      repository: overrides?.healthRepository,
    }),
  );

  router.use(
    '/auth',
    createAuthModule({
      db,
      config,
      sessions,
      requireSession: sessionGuard,
      userRepository: overrides?.userRepository,
    }),
  );

  router.use(
    '/users/me',
    createAccountModule({
      db,
      config,
      requireSession: sessionGuard,
      repository: overrides?.accountRepository,
    }),
  );

  const invitations = createInvitationModule({
    db,
    config,
    requireSession: sessionGuard,
    repository: overrides?.invitationRepository,
    workspaceRepository: overrides?.workspaceRepository,
    userDirectory: overrides?.userDirectory,
  });
  // Mounted before /workspaces so these requests are authenticated once, by
  // this router, and never reach the workspaces router.
  router.use('/workspaces/:workspaceId/invitations', invitations.workspaceInvitations);
  router.use('/invitations', invitations.invitationResponses);
  router.use(
    '/notifications',
    createNotificationModule({
      db,
      requireSession: sessionGuard,
      repository: overrides?.notificationRepository,
    }),
  );
  // Most specific first: comments/activities, then tasks, then projects/dashboard, then /workspaces.
  router.use(
    '/workspaces/:workspaceId/projects/:projectId/tasks/:taskId/activities',
    createActivityModule({
      db,
      requireSession: sessionGuard,
      repository: overrides?.activityRepository,
      workspaceRepository: overrides?.workspaceRepository,
    }),
  );
  router.use(
    '/workspaces/:workspaceId/projects/:projectId/tasks/:taskId/comments',
    createCommentModule({
      db,
      requireSession: sessionGuard,
      repository: overrides?.commentRepository,
      workspaceRepository: overrides?.workspaceRepository,
    }),
  );
  router.use(
    '/workspaces/:workspaceId/projects/:projectId/tasks',
    createTaskModule({
      db,
      requireSession: sessionGuard,
      repository: overrides?.taskRepository,
      workspaceRepository: overrides?.workspaceRepository,
    }),
  );
  router.use(
    '/workspaces/:workspaceId/dashboard',
    createDashboardModule({
      db,
      requireSession: sessionGuard,
      repository: overrides?.dashboardRepository,
      workspaceRepository: overrides?.workspaceRepository,
    }),
  );
  router.use(
    '/workspaces/:workspaceId/projects',
    createProjectModule({
      db,
      requireSession: sessionGuard,
      repository: overrides?.projectRepository,
      workspaceRepository: overrides?.workspaceRepository,
    }),
  );

  router.use(
    '/workspaces',
    createWorkspaceModule({
      db,
      requireSession: sessionGuard,
      repository: overrides?.workspaceRepository,
    }),
  );

  return router;
}
