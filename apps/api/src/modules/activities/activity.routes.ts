import { Router, type RequestHandler } from 'express';

import { validate } from '../../core/middleware/validate.js';
import type { ActivityController } from './activity.controller.js';
import { listActivitiesQuerySchema, taskActivitiesParamsSchema } from './activity.validators.js';

/**
 * Mounted at /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/activities.
 * Read-only by design: there is deliberately no route to create, edit or
 * delete activity entries (they are written only by the operations they record).
 */
export function createActivityRouter(
  controller: ActivityController,
  guards: { requireSession: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });

  router.use(guards.requireSession);

  // GET: any member, archived projects included; no CSRF token needed.
  router.get(
    '/',
    validate({ params: taskActivitiesParamsSchema, query: listActivitiesQuerySchema }),
    controller.list,
  );

  return router;
}
