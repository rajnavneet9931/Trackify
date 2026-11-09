import { Router, type RequestHandler } from 'express';

import { requireJson } from '../../core/middleware/require-json.js';
import { validate } from '../../core/middleware/validate.js';
import type { InvitationController } from './invitation.controller.js';
import {
  createInvitationBodySchema,
  invitationParamsSchema,
  invitationTokenBodySchema,
  workspaceInvitationsParamsSchema,
} from './invitation.validators.js';

interface Guards {
  /** Authentication + CSRF on unsafe methods (shared session guard). */
  requireSession: RequestHandler;
  /** Per-user limit on creating invitations; runs after authentication. */
  createLimit: RequestHandler;
}

/** Owner side, mounted at /workspaces/:workspaceId/invitations. */
export function createWorkspaceInvitationsRouter(
  controller: InvitationController,
  guards: Guards,
): Router {
  const router = Router({ mergeParams: true });
  router.use(guards.requireSession);

  router.post(
    '/',
    guards.createLimit,
    requireJson,
    validate({ params: workspaceInvitationsParamsSchema, body: createInvitationBodySchema }),
    controller.create,
  );
  router.get('/:invitationId', validate({ params: invitationParamsSchema }), controller.get);
  router.post(
    '/:invitationId/revoke',
    validate({ params: invitationParamsSchema }),
    controller.revoke,
  );

  return router;
}

/** Invitee side, mounted at /invitations. The token is sent in the JSON body. */
export function createInvitationResponseRouter(
  controller: InvitationController,
  guards: Pick<Guards, 'requireSession'>,
): Router {
  const router = Router();
  router.use(guards.requireSession);

  const tokenBody = [requireJson, validate({ body: invitationTokenBodySchema })];
  router.post('/accept', ...tokenBody, controller.accept);
  router.post('/decline', ...tokenBody, controller.decline);

  return router;
}
