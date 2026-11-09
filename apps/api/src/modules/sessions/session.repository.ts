import type { DatabaseClient } from '../../infrastructure/database/prisma.js';
import type { PublicUser } from '../users/index.js';

export interface ActiveSession {
  id: string;
  expiresAt: Date;
  user: PublicUser;
}

export interface NewSession {
  userId: string;
  tokenHash: Uint8Array<ArrayBuffer>;
  expiresAt: Date;
}

export interface SessionRepository {
  /**
   * Atomically: deletes the session being replaced (if any) and the user's
   * expired sessions, then inserts the new one.
   */
  replace(
    session: NewSession,
    replacedTokenHash?: Uint8Array<ArrayBuffer>,
  ): Promise<{ id: string }>;
  /** One indexed lookup: the unexpired session for this token hash, with its user. */
  findActive(tokenHash: Uint8Array<ArrayBuffer>, now: Date): Promise<ActiveSession | null>;
  /** Deletes one session by ID. Returns false if it no longer existed. */
  delete(sessionId: string): Promise<boolean>;
}

export class PrismaSessionRepository implements SessionRepository {
  constructor(private readonly db: DatabaseClient) {}

  async replace(
    { userId, tokenHash, expiresAt }: NewSession,
    replacedTokenHash?: Uint8Array<ArrayBuffer>,
  ): Promise<{ id: string }> {
    return this.db.$transaction(async (tx) => {
      if (replacedTokenHash) {
        await tx.session.deleteMany({ where: { tokenHash: replacedTokenHash } });
      }
      // Opportunistic cleanup keeps each user's expired rows from accumulating.
      await tx.session.deleteMany({ where: { userId, expiresAt: { lte: new Date() } } });
      return tx.session.create({
        data: { userId, tokenHash, expiresAt },
        select: { id: true },
      });
    });
  }

  async findActive(tokenHash: Uint8Array<ArrayBuffer>, now: Date): Promise<ActiveSession | null> {
    const session = await this.db.session.findFirst({
      where: { tokenHash, expiresAt: { gt: now } },
      select: {
        id: true,
        expiresAt: true,
        user: { select: { id: true, email: true, createdAt: true } },
      },
    });
    return session;
  }

  async delete(sessionId: string): Promise<boolean> {
    // deleteMany: a concurrent logout may already have removed the row; that is not an error.
    const { count } = await this.db.session.deleteMany({ where: { id: sessionId } });
    return count > 0;
  }
}
