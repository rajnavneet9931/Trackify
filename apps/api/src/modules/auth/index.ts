import type { Request, RequestHandler, Router } from 'express';

import type { AppConfig } from '../../config/env.js';
import { createRateLimiter } from '../../core/middleware/rate-limit.js';
import type { DatabaseClient } from '../../infrastructure/database/prisma.js';
import type { SessionService } from '../sessions/index.js';
import { normalizeEmail, PrismaUserRepository, type UserRepository } from '../users/index.js';
import { AuthController } from './auth.controller.js';
import { createAuthRouter } from './auth.routes.js';
import { AuthService } from './auth.service.js';
import { argon2PasswordHasher } from './password-hasher.js';

// Public API of the auth module, for other modules (e.g. account: password changes).
export { argon2PasswordHasher, type PasswordHasher } from './password-hasher.js';
export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordSchema } from './auth.validators.js';

export interface AuthModuleDeps {
  db: DatabaseClient;
  config: AppConfig;
  /** Shared with other modules: one session service and guard for the whole API. */
  sessions: SessionService;
  requireSession: RequestHandler;
  /** Override for tests. Defaults to the Prisma-backed implementation. */
  userRepository?: UserRepository | undefined;
}

/** Per-account bucket for failed logins; requests without a usable email share one key. */
function loginAccountKey(req: Request): string {
  const email: unknown = req.body?.email;
  return `login:${typeof email === 'string' ? normalizeEmail(email).slice(0, 320) : ''}`;
}

/** Composition root for the auth module: wires repository → service → controller → router. */
export function createAuthModule({
  db,
  config,
  sessions,
  requireSession,
  userRepository,
}: AuthModuleDeps): Router {
  const { session, registerRateLimit, loginRateLimit, loginAccountRateLimit } = config.auth;

  const service = new AuthService(
    userRepository ?? new PrismaUserRepository(db),
    argon2PasswordHasher,
    sessions,
  );

  return createAuthRouter(new AuthController(service, session.cookie), {
    registerLimit: createRateLimiter(registerRateLimit),
    loginLimits: [
      createRateLimiter(loginRateLimit),
      createRateLimiter({
        ...loginAccountRateLimit,
        keyGenerator: loginAccountKey,
        skipSuccessfulRequests: true,
      }),
    ],
    requireSession,
  });
}
