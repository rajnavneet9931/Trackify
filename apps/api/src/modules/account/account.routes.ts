import { Router, type Request, type RequestHandler, type Response } from 'express';

import type { SessionConfig } from '../../config/env.js';
import { sendSuccess } from '../../core/http/api-response.js';
import { requireJson } from '../../core/middleware/require-json.js';
import { validate } from '../../core/middleware/validate.js';
import { clearSessionCookie, getAuth } from '../sessions/index.js';
import type { AccountSettings, Profile } from './account.model.js';
import type { AccountService } from './account.service.js';
import {
  changePasswordBodySchema,
  noInputSchema,
  updateProfileBodySchema,
  updateSettingsBodySchema,
  type ChangePasswordBody,
  type UpdateProfileBody,
  type UpdateSettingsBody,
} from './account.validators.js';

/** Response shapes. Built field by field: never a password hash or session data. */
function toProfileResponse(p: Profile) {
  return { id: p.id, email: p.email, name: p.name, createdAt: p.createdAt.toISOString() };
}

function toSettingsResponse(s: AccountSettings) {
  return {
    timeZone: s.timeZone,
    dateFormat: s.dateFormat,
    notifications: {
      taskAssigned: s.notifications.taskAssigned,
      taskCommented: s.notifications.taskCommented,
      taskReminder: s.notifications.taskReminder,
    },
  };
}

/**
 * Mounted at /users/me: only ever the signed-in user's own account (there is
 * no user id in any URL or body). Unsafe methods need the CSRF token.
 */
export function createAccountRouter(
  service: AccountService,
  guards: {
    requireSession: RequestHandler;
    /** Failed password changes per user (guessing the current password). */
    passwordLimit: RequestHandler;
    cookie: SessionConfig['cookie'];
  },
): Router {
  const router = Router();
  router.use(guards.requireSession);
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/', validate({ query: noInputSchema }), async (req: Request, res: Response) => {
    sendSuccess(res, { user: toProfileResponse(await service.getProfile(getAuth(req).user.id)) });
  });

  router.patch(
    '/',
    requireJson,
    validate({ query: noInputSchema, body: updateProfileBodySchema }),
    async (req: Request, res: Response) => {
      const { name } = req.body as UpdateProfileBody;
      const profile = await service.updateProfile(getAuth(req).user.id, { name });
      sendSuccess(res, { user: toProfileResponse(profile) });
    },
  );

  router.patch(
    '/password',
    guards.passwordLimit,
    requireJson,
    validate({ query: noInputSchema, body: changePasswordBodySchema }),
    async (req: Request, res: Response) => {
      const { user } = getAuth(req);
      await service.changePassword(user.id, user.email, req.body as ChangePasswordBody);
      // Every session (this one too) was deleted with the change: sign in again.
      clearSessionCookie(res, guards.cookie);
      sendSuccess(res, { passwordChanged: true, signedOut: true });
    },
  );

  router.get(
    '/settings',
    validate({ query: noInputSchema }),
    async (req: Request, res: Response) => {
      const settings = await service.getSettings(getAuth(req).user.id);
      sendSuccess(res, { settings: toSettingsResponse(settings) });
    },
  );

  router.patch(
    '/settings',
    requireJson,
    validate({ query: noInputSchema, body: updateSettingsBodySchema }),
    async (req: Request, res: Response) => {
      const settings = await service.updateSettings(
        getAuth(req).user.id,
        req.body as UpdateSettingsBody,
      );
      sendSuccess(res, { settings: toSettingsResponse(settings) });
    },
  );

  return router;
}
