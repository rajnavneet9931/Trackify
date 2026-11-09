import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { SessionConfig } from '../../config/env.js';
import { ForbiddenError, UnauthorizedError } from '../../core/errors/app-error.js';
import { clearSessionCookie, readSessionCookie } from './session-cookie.js';
import { csrfTokenMatches } from './session-token.js';
import type { AuthContext, SessionService } from './session.service.js';

export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireSession for authenticated requests. */
      auth?: AuthContext;
    }
  }
}

/** Reads `req.auth` in handlers mounted behind requireSession. */
export function getAuth(req: Request): AuthContext {
  if (!req.auth) throw new UnauthorizedError();
  return req.auth;
}

/**
 * Authenticates the request from the session cookie (one indexed query) and,
 * for unsafe methods, requires the session's CSRF token in `X-CSRF-Token`
 * (CSRF layer 2). Missing, malformed, unknown, revoked and expired sessions
 * all get the same 401; a stale cookie is cleared.
 */
export function requireSession(
  sessions: SessionService,
  cookie: SessionConfig['cookie'],
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = readSessionCookie(req, cookie);
    const auth = token === undefined ? null : await sessions.authenticate(token);

    if (!auth) {
      if (token !== undefined) clearSessionCookie(res, cookie);
      throw new UnauthorizedError();
    }

    if (!SAFE_METHODS.has(req.method) && !csrfTokenMatches(auth.token, req.get(CSRF_HEADER))) {
      throw new ForbiddenError('Invalid or missing CSRF token');
    }

    req.auth = auth;
    next();
  };
}
