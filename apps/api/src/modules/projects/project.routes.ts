import { Router, type RequestHandler } from 'express';

import { requireJson } from '../../core/middleware/require-json.js';
import { validate } from '../../core/middleware/validate.js';
import { workspaceParamsSchema } from '../workspaces/index.js';
import type { ProjectController } from './project.controller.js';
import {
  createProjectBodySchema,
  listProjectsQuerySchema,
  noInputSchema,
  projectParamsSchema,
  updateProjectBodySchema,
} from './project.validators.js';

// Lifecycle actions take only the two URL IDs: no query parameters, no body fields.
const pathOnly = validate({
  params: projectParamsSchema,
  query: noInputSchema,
  body: noInputSchema.optional(),
});

/** Mounted at /workspaces/:workspaceId/projects. */
export function createProjectRouter(
  controller: ProjectController,
  guards: { requireSession: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });

  // Authentication (and CSRF on unsafe methods) first: anonymous callers learn nothing.
  router.use(guards.requireSession);

  // GET: any member; no CSRF token needed (safe method), Origin/CORS as usual.
  router.get(
    '/',
    validate({ params: workspaceParamsSchema, query: listProjectsQuerySchema }),
    controller.list,
  );

  router.post(
    '/',
    requireJson,
    validate({ params: workspaceParamsSchema, body: createProjectBodySchema }),
    controller.create,
  );

  // Details: any member, archived projects included.
  router.get(
    '/:projectId',
    validate({ params: projectParamsSchema, query: noInputSchema }),
    controller.get,
  );

  // Mutations: owners only (checked inside the mutation transaction); CSRF +
  // Origin enforced by requireSession/verifyOrigin.
  router.patch(
    '/:projectId',
    requireJson,
    validate({ params: projectParamsSchema, query: noInputSchema, body: updateProjectBodySchema }),
    controller.update,
  );
  router.post('/:projectId/archive', pathOnly, controller.archive);
  router.post('/:projectId/restore', pathOnly, controller.restore);
  router.delete('/:projectId', pathOnly, controller.delete);

  return router;
}
