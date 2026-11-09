import { Router, type RequestHandler } from 'express';

import { requireJson } from '../../core/middleware/require-json.js';
import { validate } from '../../core/middleware/validate.js';
import type { AuthController } from './auth.controller.js';
import { loginBodySchema, registerBodySchema } from './auth.validators.js';

export interface AuthRouteGuards {
  registerLimit: RequestHandler;
  loginLimits: RequestHandler[];
  requireSession: RequestHandler;
}

export function createAuthRouter(controller: AuthController, guards: AuthRouteGuards): Router {
  const router = Router();

  // Limiters run first so rejected and malformed attempts count too.
  router.post(
    '/register',
    guards.registerLimit,
    requireJson,
    validate({ body: registerBodySchema }),
    controller.register,
  );

  router.post(
    '/login',
    ...guards.loginLimits,
    requireJson,
    validate({ body: loginBodySchema }),
    controller.login,
  );

  router.get('/me', guards.requireSession, controller.me);

  // No body, so no requireJson; requireSession enforces X-CSRF-Token on POST.
  router.post('/logout', guards.requireSession, controller.logout);

  return router;
}
