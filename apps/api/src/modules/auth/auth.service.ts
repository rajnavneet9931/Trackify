import { randomBytes } from 'node:crypto';

import { ConflictError, UnauthorizedError } from '../../core/errors/app-error.js';
import type { IssuedSession, SessionService } from '../sessions/index.js';
import {
  EmailAlreadyRegisteredError,
  normalizeEmail,
  type PublicUser,
  type UserRepository,
} from '../users/index.js';
import type { PasswordHasher } from './password-hasher.js';

export interface RegisterInput {
  email: string;
  password: string;
}

export interface LoginInput {
  email: string;
  password: string;
  /** Session token the client already holds, if any; it is revoked on login. */
  presentedSessionToken?: string | undefined;
}

export interface LoginResult {
  user: PublicUser;
  session: IssuedSession;
}

export const EMAIL_TAKEN_MESSAGE = 'An account with this email address already exists';
export const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password';

export class AuthService {
  /** Hash verified when the email is unknown, so both failure paths cost one Argon2 run. */
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly users: UserRepository,
    private readonly passwords: PasswordHasher,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Creates an account. Exactly one database round trip; no session or token
   * is issued. Email is normalized here as well as in the validator, so the
   * rule holds for any caller of the service.
   */
  async register({ email, password }: RegisterInput): Promise<PublicUser> {
    const passwordHash = await this.passwords.hash(password);

    try {
      return await this.users.create({ email: normalizeEmail(email), passwordHash });
    } catch (error) {
      if (error instanceof EmailAlreadyRegisteredError) {
        throw new ConflictError(EMAIL_TAKEN_MESSAGE);
      }
      throw error;
    }
  }

  /**
   * Verifies credentials and issues a fresh session. Unknown email and wrong
   * password produce the same error after the same amount of hashing work.
   */
  async login({ email, password, presentedSessionToken }: LoginInput): Promise<LoginResult> {
    const credentials = await this.users.findCredentialsByEmail(normalizeEmail(email));
    const hash = credentials?.passwordHash ?? (await this.getDummyHash());
    const passwordMatches = await this.passwords.verify(hash, password);

    if (!credentials || !passwordMatches) {
      throw new UnauthorizedError(INVALID_CREDENTIALS_MESSAGE);
    }

    const session = await this.sessions.create(credentials.id, presentedSessionToken);
    return {
      user: { id: credentials.id, email: credentials.email, createdAt: credentials.createdAt },
      session,
    };
  }

  /** Ends the current session only (other devices stay signed in). */
  async logout(sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId);
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.passwords.hash(randomBytes(32).toString('base64url'));
    return this.dummyHash;
  }
}
