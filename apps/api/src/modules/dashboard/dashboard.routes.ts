import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import { validate } from '../../core/middleware/validate.js';
import { workspaceParamsSchema } from '../workspaces/index.js';
import type { DashboardController } from './dashboard.controller.js';

/** The dashboard takes no query parameters; any is a 400. */
const noQuerySchema = z.strictObject({});

/** Mounted at /workspaces/:workspaceId/dashboard. Read-only. */
export function createDashboardRouter(
  controller: DashboardController,
  guards: { requireSession: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });

  router.use(guards.requireSession);

  // GET: any member; membership is checked in the service before any read.
  router.get(
    '/',
    validate({ params: workspaceParamsSchema, query: noQuerySchema }),
    controller.get,
  );

  return router;
}
