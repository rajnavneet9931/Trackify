import { Router, type RequestHandler } from 'express';

import { requireJson } from '../../core/middleware/require-json.js';
import { validate } from '../../core/middleware/validate.js';
import type { TaskController } from './task.controller.js';
import {
  assignTaskBodySchema,
  createTaskBodySchema,
  listTasksQuerySchema,
  noInputSchema,
  projectTasksParamsSchema,
  taskParamsSchema,
  updateTaskBodySchema,
} from './task.validators.js';

/** Mounted at /workspaces/:workspaceId/projects/:projectId/tasks. */
export function createTaskRouter(
  controller: TaskController,
  guards: { requireSession: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });

  // Authentication (and CSRF on unsafe methods) first: anonymous callers learn nothing.
  router.use(guards.requireSession);

  // GETs: any member, archived projects included; no CSRF token needed.
  router.get(
    '/',
    validate({ params: projectTasksParamsSchema, query: listTasksQuerySchema }),
    controller.list,
  );
  router.get(
    '/:taskId',
    validate({ params: taskParamsSchema, query: noInputSchema }),
    controller.get,
  );

  // Mutations: any member, active projects only; CSRF + Origin enforced.
  router.post(
    '/',
    requireJson,
    validate({
      params: projectTasksParamsSchema,
      query: noInputSchema,
      body: createTaskBodySchema,
    }),
    controller.create,
  );
  router.patch(
    '/:taskId',
    requireJson,
    validate({ params: taskParamsSchema, query: noInputSchema, body: updateTaskBodySchema }),
    controller.update,
  );
  router.patch(
    '/:taskId/assignee',
    requireJson,
    validate({ params: taskParamsSchema, query: noInputSchema, body: assignTaskBodySchema }),
    controller.assign,
  );

  return router;
}
