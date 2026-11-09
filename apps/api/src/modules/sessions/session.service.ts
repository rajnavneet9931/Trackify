import type { PublicUser } from '../users/index.js';
import {
  deriveCsrfToken,
  generateSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
} from './session-token.js';
import type { SessionRepository } from './session.repository.js';

export interface IssuedSession {
  /** Goes into the HttpOnly cookie only. Never logged, returned in a body, or stored. */
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export interface AuthContext {
  user: PublicUser;
  sessionId: string;
  /** Raw token from the request cookie; needed to verify the CSRF token. */
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export class SessionService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly ttlMs: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Issues a brand-new server-generated session (never reusing a client-supplied
   * ID, which prevents session fixation) and revokes the session the client
   * presented, if any.
   */
  async create(userId: string, presentedToken?: string): Promise<IssuedSession> {
    const token = generateSessionToken();
    const expiresAt = new Date(this.now().getTime() + this.ttlMs);

    await this.sessions.replace(
      { userId, tokenHash: hashSessionToken(token), expiresAt },
      isWellFormedSessionToken(presentedToken) ? hashSessionToken(presentedToken) : undefined,
    );

    return { token, csrfToken: deriveCsrfToken(token), expiresAt };
  }

  /** Returns the authenticated context, or null for unknown, revoked or expired tokens. */
  async authenticate(token: unknown): Promise<AuthContext | null> {
    if (!isWellFormedSessionToken(token)) return null;

    const session = await this.sessions.findActive(hashSessionToken(token), this.now());
    if (!session) return null;

    return {
      user: session.user,
      sessionId: session.id,
      token,
      csrfToken: deriveCsrfToken(token),
      expiresAt: session.expiresAt,
    };
  }

  /**
   * Revokes one session server-side. Only that session is affected; the
   * user's other sessions stay valid. Database errors propagate, so a failed
   * revocation is never reported as success.
   */
  async revoke(sessionId: string): Promise<void> {
    await this.sessions.delete(sessionId);
  }
}
