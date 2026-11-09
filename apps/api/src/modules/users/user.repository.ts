import { isUniqueViolation } from '../../infrastructure/database/database-errors.js';
import type { DatabaseClient } from '../../infrastructure/database/prisma.js';
import { publicUserSelect, type PublicUser } from './user.model.js';

const EMAIL_UNIQUE_INDEX = 'users_email_key';

/** Raised when the database rejects a user because the email is already registered. */
export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super('Email already registered');
    this.name = 'EmailAlreadyRegisteredError';
  }
}

export interface NewUser {
  /** Must already be normalized (see normalizeEmail). */
  email: string;
  passwordHash: string;
}

/** A user plus the password hash. For credential checks only; never serialize. */
export interface UserCredentials extends PublicUser {
  passwordHash: string;
}

export interface UserRepository {
  /** Inserts a user. Throws EmailAlreadyRegisteredError on a duplicate email. */
  create(user: NewUser): Promise<PublicUser>;
  /** Looks up a user by normalized email for login. */
  findCredentialsByEmail(email: string): Promise<UserCredentials | null>;
}

/** Minimal lookup for other modules (e.g. invitations): never exposes the password hash. */
export interface UserDirectory {
  findByEmail(email: string): Promise<{ id: string; email: string } | null>;
}

export class PrismaUserRepository implements UserRepository, UserDirectory {
  constructor(private readonly db: DatabaseClient) {}

  /**
   * Single INSERT with no prior lookup: the unique index is the authority on
   * duplicates, which keeps concurrent registrations for one email correct.
   */
  async create({ email, passwordHash }: NewUser): Promise<PublicUser> {
    try {
      return await this.db.user.create({
        // Fields listed explicitly: nothing else from the request can be persisted.
        data: { email, passwordHash },
        select: publicUserSelect,
      });
    } catch (error) {
      if (isUniqueViolation(error, EMAIL_UNIQUE_INDEX)) throw new EmailAlreadyRegisteredError();
      throw error;
    }
  }

  findCredentialsByEmail(email: string): Promise<UserCredentials | null> {
    return this.db.user.findUnique({
      where: { email },
      select: { ...publicUserSelect, passwordHash: true },
    });
  }

  findByEmail(email: string): Promise<{ id: string; email: string } | null> {
    return this.db.user.findUnique({ where: { email }, select: { id: true, email: true } });
  }
}
