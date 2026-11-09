import type { Request, Response } from 'express';

import type { SessionConfig } from '../../config/env.js';
import { sendSuccess } from '../../core/http/api-response.js';
import {
  clearSessionCookie,
  getAuth,
  readSessionCookie,
  setSessionCookie,
} from '../sessions/index.js';
import type { PublicUser } from '../users/index.js';
import type { AuthService } from './auth.service.js';
import type { LoginBody, RegisterBody } from './auth.validators.js';

/** Response shape for a user. Built field by field so nothing else can leak. */
function toUserResponse(user: PublicUser) {
  return { id: user.id, email: user.email, createdAt: user.createdAt.toISOString() };
}

export class AuthController {
  constructor(
    private readonly service: AuthService,
    private readonly cookie: SessionConfig['cookie'],
  ) {}

  /** Body has already been validated and normalized by the route's validate() middleware. */
  register = async (req: Request, res: Response): Promise<void> => {
    const { email, password } = req.body as RegisterBody;
    const user = await this.service.register({ email, password });
    sendSuccess(res, { user: toUserResponse(user) }, 201);
  };

  /** The session token goes into the HttpOnly cookie only, never into the body. */
  login = async (req: Request, res: Response): Promise<void> => {
    const { email, password } = req.body as LoginBody;
    const { user, session } = await this.service.login({
      email,
      password,
      presentedSessionToken: readSessionCookie(req, this.cookie),
    });

    setSessionCookie(res, this.cookie, session.token, session.expiresAt);
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, {
      user: toUserResponse(user),
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt.toISOString(),
    });
  };

  /**
   * Behind requireSession (valid session + CSRF token). The server-side record
   * is deleted first; the cookie is cleared only after that succeeded, so a
   * database failure (503) never looks like a completed logout.
   */
  logout = async (req: Request, res: Response): Promise<void> => {
    await this.service.logout(getAuth(req).sessionId);

    clearSessionCookie(res, this.cookie);
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, { loggedOut: true });
  };

  /** Current user for a valid session, plus the CSRF token for unsafe requests. */
  me = (req: Request, res: Response): void => {
    const auth = getAuth(req);
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, {
      user: toUserResponse(auth.user),
      csrfToken: auth.csrfToken,
      expiresAt: auth.expiresAt.toISOString(),
    });
  };
}
