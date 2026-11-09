import type { RequestHandler, Router } from 'express';

import type { DatabaseClient } from '../../infrastructure/database/prisma.js';
import {
  PrismaWorkspaceRepository,
  WorkspaceAccess,
  type WorkspaceRepository,
} from '../workspaces/index.js';
import { CommentController } from './comment.controller.js';
import { PrismaCommentRepository, type CommentRepository } from './comment.repository.js';
import { createCommentRouter } from './comment.routes.js';
import { CommentService } from './comment.service.js';

// Public API of the comments module.
export type { CommentView } from './comment.model.js';
export {
  PrismaCommentRepository,
  type CommentMutationScope,
  type CommentPageQuery,
  type CommentRepository,
  type LockedComment,
} from './comment.repository.js';

export interface CommentModuleDeps {
  db: DatabaseClient;
  requireSession: RequestHandler;
  /** Overrides for tests. Default to the Prisma-backed implementations. */
  repository?: CommentRepository | undefined;
  workspaceRepository?: WorkspaceRepository | undefined;
}

/** Composition root for the comments module: repository → service → controller → router. */
export function createCommentModule({
  db,
  requireSession,
  repository,
  workspaceRepository,
}: CommentModuleDeps): Router {
  const service = new CommentService(
    repository ?? new PrismaCommentRepository(db),
    new WorkspaceAccess(workspaceRepository ?? new PrismaWorkspaceRepository(db)),
  );
  return createCommentRouter(new CommentController(service), { requireSession });
}
