import { Router, type RequestHandler } from 'express';

import { requireJson } from '../../core/middleware/require-json.js';
import { validate } from '../../core/middleware/validate.js';
import type { CommentController } from './comment.controller.js';
import {
  commentParamsSchema,
  createCommentBodySchema,
  listCommentsQuerySchema,
  noInputSchema,
  taskCommentsParamsSchema,
  updateCommentBodySchema,
} from './comment.validators.js';

/** Mounted at /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/comments. */
export function createCommentRouter(
  controller: CommentController,
  guards: { requireSession: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });

  // Authentication (and CSRF on unsafe methods) first: anonymous callers learn nothing.
  router.use(guards.requireSession);

  // GET: any member, archived projects included; no CSRF token needed.
  router.get(
    '/',
    validate({ params: taskCommentsParamsSchema, query: listCommentsQuerySchema }),
    controller.list,
  );

  // Mutations: CSRF + Origin enforced; active projects only.
  router.post(
    '/',
    requireJson,
    validate({
      params: taskCommentsParamsSchema,
      query: noInputSchema,
      body: createCommentBodySchema,
    }),
    controller.create,
  );
  router.patch(
    '/:commentId',
    requireJson,
    validate({ params: commentParamsSchema, query: noInputSchema, body: updateCommentBodySchema }),
    controller.update,
  );
  router.delete(
    '/:commentId',
    validate({ params: commentParamsSchema, query: noInputSchema, body: noInputSchema.optional() }),
    controller.delete,
  );

  return router;
}
