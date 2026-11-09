import { Router, type RequestHandler } from 'express';

import { requireJson } from '../../core/middleware/require-json.js';
import { validate } from '../../core/middleware/validate.js';
import type { WorkspaceController } from './workspace.controller.js';
import {
  changeRoleBodySchema,
  createWorkspaceBodySchema,
  listMembersQuerySchema,
  listWorkspacesQuerySchema,
  memberParamsSchema,
  noInputSchema,
  updateSettingsBodySchema,
  workspaceParamsSchema,
} from './workspace.validators.js';

export function createWorkspaceRouter(
  controller: WorkspaceController,
  guards: { requireSession: RequestHandler },
): Router {
  const router = Router();

  // Authentication (and CSRF for unsafe methods) runs first, so unauthenticated
  // callers learn nothing, not even validation rules.
  router.use(guards.requireSession);

  router.get('/', validate({ query: listWorkspacesQuerySchema }), controller.list);
  router.post('/', requireJson, validate({ body: createWorkspaceBodySchema }), controller.create);

  // Membership is checked in the service (WorkspaceAccess) before any read.
  router.get('/:workspaceId', validate({ params: workspaceParamsSchema }), controller.get);
  router.get(
    '/:workspaceId/members',
    validate({ params: workspaceParamsSchema, query: listMembersQuerySchema }),
    controller.listMembers,
  );
  // DELETE: CSRF + Origin enforced by requireSession/verifyOrigin. Only the two
  // URL IDs are input; any query parameter or body field is rejected.
  router.delete(
    '/:workspaceId/members/:userId',
    validate({ params: memberParamsSchema, query: noInputSchema, body: noInputSchema.optional() }),
    controller.removeMember,
  );
  // PATCH: CSRF + Origin as above. Body is exactly { role }; no query parameters.
  router.patch(
    '/:workspaceId/members/:userId/role',
    requireJson,
    validate({ params: memberParamsSchema, query: noInputSchema, body: changeRoleBodySchema }),
    controller.changeRole,
  );

  // Settings: any member reads; owners edit (CSRF + Origin; strict JSON body).
  router.get(
    '/:workspaceId/settings',
    validate({ params: workspaceParamsSchema, query: noInputSchema }),
    controller.getSettings,
  );
  router.patch(
    '/:workspaceId/settings',
    requireJson,
    validate({
      params: workspaceParamsSchema,
      query: noInputSchema,
      body: updateSettingsBodySchema,
    }),
    controller.updateSettings,
  );
  // DELETE: owners only (checked in the service, inside the workspace lock).
  // Only the URL ID is input; any query parameter or body field is rejected.
  router.delete(
    '/:workspaceId',
    validate({
      params: workspaceParamsSchema,
      query: noInputSchema,
      body: noInputSchema.optional(),
    }),
    controller.deleteWorkspace,
  );

  return router;
}
