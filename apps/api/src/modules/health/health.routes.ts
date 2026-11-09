import { Router } from 'express';

import type { HealthController } from './health.controller.js';

export function createHealthRouter(controller: HealthController): Router {
  const router = Router();

  router.get('/', controller.liveness);
  router.get('/ready', controller.readiness);

  return router;
}
