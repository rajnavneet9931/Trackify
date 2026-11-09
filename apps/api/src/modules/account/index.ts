import type { RequestHandler, Router } from 'express';

import type { AppConfig } from '../../config/env.js';
import { createRateLimiter } from '../../core/middleware/rate-limit.js';
import type { DatabaseClient } from '../../infrastructure/database/prisma.js';
import { argon2PasswordHasher } from '../auth/index.js';
import { getAuth } from '../sessions/index.js';
import { PrismaAccountRepository, type AccountRepository } from './account.repository.js';
import { createAccountRouter } from './account.routes.js';
import { AccountService } from './account.service.js';

// Public API of the account module.
export { mutedNotificationTypes } from './notification-preferences.js';
export {
  DateFormat,
  DEFAULT_SETTINGS,
  type AccountSettings,
  type NotificationPreferences,
  type Profile,
  type SettingsChanges,
} from './account.model.js';
export { PrismaAccountRepository, type AccountRepository } from './account.repository.js';

export interface AccountModuleDeps {
  db: DatabaseClient;
  config: AppConfig;
  requireSession: RequestHandler;
  /** Override for tests. Defaults to the Prisma-backed implementation. */
  repository?: AccountRepository | undefined;
}

/** Composition root for /users/me: profile, password and settings of the signed-in user. */
export function createAccountModule({
  db,
  config,
  requireSession,
  repository,
}: AccountModuleDeps): Router {
  const service = new AccountService(
    repository ?? new PrismaAccountRepository(db),
    argon2PasswordHasher,
  );
  return createAccountRouter(service, {
    requireSession,
    // Same budget as failed logins per account: guessing the current password
    // through this endpoint is no easier than through /auth/login.
    passwordLimit: createRateLimiter({
      ...config.auth.loginAccountRateLimit,
      keyGenerator: (req) => `password:${getAuth(req).user.id}`,
      skipSuccessfulRequests: true,
    }),
    cookie: config.auth.session.cookie,
  });
}
