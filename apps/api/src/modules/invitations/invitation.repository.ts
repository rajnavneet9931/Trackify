import { isUniqueViolation } from '../../infrastructure/database/database-errors.js';
import type { DatabaseClient } from '../../infrastructure/database/prisma.js';
import { WorkspaceRole, type WorkspaceSummary } from '../workspaces/index.js';
import { InvitationStatus, invitationViewSelect, type InvitationView } from './invitation.model.js';

const ONE_PENDING_INDEX = 'workspace_invitations_one_pending_key';
const MEMBERSHIP_UNIQUE_INDEX = 'workspace_members_workspace_id_user_id_key';

/** The database already holds a PENDING invitation for this workspace and email. */
export class PendingInvitationExistsError extends Error {
  constructor() {
    super('Pending invitation exists');
    this.name = 'PendingInvitationExistsError';
  }
}

/** The invitation was no longer PENDING (or had expired) when we tried to use it. */
export class InvitationNotPendingError extends Error {
  constructor() {
    super('Invitation not pending');
    this.name = 'InvitationNotPendingError';
  }
}

/** The invitee is already a member; the whole acceptance was rolled back. */
export class AlreadyMemberError extends Error {
  constructor() {
    super('Already a member');
    this.name = 'AlreadyMemberError';
  }
}

export interface NewInvitation {
  workspaceId: string;
  inviterId: string;
  /** Normalized email. */
  email: string;
  tokenHash: Uint8Array<ArrayBuffer>;
  expiresAt: Date;
}

/** Internal row used to validate a presented token. */
export interface InvitationForToken {
  id: string;
  workspaceId: string;
  email: string;
  status: InvitationStatus;
  expiresAt: Date;
}

export interface InvitationRepository {
  /**
   * Inserts a PENDING invitation. In the same transaction, a stale PENDING row
   * for the same workspace+email that has already expired is marked EXPIRED, so
   * it no longer occupies the one-pending slot. Throws
   * PendingInvitationExistsError if a live PENDING invitation exists (enforced
   * by the partial unique index, also under concurrency).
   */
  create(invitation: NewInvitation, now: Date): Promise<InvitationView>;
  findInWorkspace(workspaceId: string, invitationId: string): Promise<InvitationView | null>;
  findByTokenHash(tokenHash: Uint8Array<ArrayBuffer>): Promise<InvitationForToken | null>;
  /**
   * PENDING → ACCEPTED and the MEMBER membership, atomically. Only one
   * concurrent caller can win the conditional update; the others get
   * InvitationNotPendingError. AlreadyMemberError rolls everything back.
   */
  accept(
    invitationId: string,
    userId: string,
    now: Date,
  ): Promise<{ workspace: WorkspaceSummary; role: WorkspaceRole }>;
  /** Conditional PENDING (and unexpired) → status. False if it was not pending. */
  transition(
    invitationId: string,
    to: typeof InvitationStatus.DECLINED | typeof InvitationStatus.REVOKED,
    now: Date,
  ): Promise<boolean>;
  /** Persists lazy expiry: PENDING past expires_at → EXPIRED. */
  markExpired(invitationId: string, now: Date): Promise<void>;
}

export class PrismaInvitationRepository implements InvitationRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(invitation: NewInvitation, now: Date): Promise<InvitationView> {
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.workspaceInvitation.updateMany({
          where: {
            workspaceId: invitation.workspaceId,
            email: invitation.email,
            status: InvitationStatus.PENDING,
            expiresAt: { lte: now },
          },
          data: { status: InvitationStatus.EXPIRED },
        });
        return tx.workspaceInvitation.create({
          // Every field set explicitly from server-side values.
          data: {
            workspaceId: invitation.workspaceId,
            inviterId: invitation.inviterId,
            email: invitation.email,
            tokenHash: invitation.tokenHash,
            expiresAt: invitation.expiresAt,
            status: InvitationStatus.PENDING,
          },
          select: invitationViewSelect,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error, ONE_PENDING_INDEX)) throw new PendingInvitationExistsError();
      throw error;
    }
  }

  findInWorkspace(workspaceId: string, invitationId: string): Promise<InvitationView | null> {
    // Scoped by workspace: an ID from another workspace is simply not found.
    return this.db.workspaceInvitation.findFirst({
      where: { id: invitationId, workspaceId },
      select: invitationViewSelect,
    });
  }

  findByTokenHash(tokenHash: Uint8Array<ArrayBuffer>): Promise<InvitationForToken | null> {
    return this.db.workspaceInvitation.findUnique({
      where: { tokenHash },
      select: { id: true, workspaceId: true, email: true, status: true, expiresAt: true },
    });
  }

  async accept(invitationId: string, userId: string, now: Date) {
    try {
      return await this.db.$transaction(async (tx) => {
        // Row-locking conditional update: concurrent acceptances serialize here
        // and only the first sees count = 1.
        const { count } = await tx.workspaceInvitation.updateMany({
          where: { id: invitationId, status: InvitationStatus.PENDING, expiresAt: { gt: now } },
          data: { status: InvitationStatus.ACCEPTED },
        });
        if (count !== 1) throw new InvitationNotPendingError();

        const invitation = await tx.workspaceInvitation.findUniqueOrThrow({
          where: { id: invitationId },
          select: { workspaceId: true },
        });
        // Invitations only ever grant MEMBER. The unique (workspace_id, user_id)
        // index is the final authority against duplicate membership.
        const membership = await tx.workspaceMember.create({
          data: { workspaceId: invitation.workspaceId, userId, role: WorkspaceRole.MEMBER },
          select: {
            role: true,
            workspace: { select: { id: true, name: true, createdAt: true } },
          },
        });
        return { workspace: membership.workspace, role: membership.role };
      });
    } catch (error) {
      if (isUniqueViolation(error, MEMBERSHIP_UNIQUE_INDEX)) throw new AlreadyMemberError();
      throw error;
    }
  }

  async transition(
    invitationId: string,
    to: typeof InvitationStatus.DECLINED | typeof InvitationStatus.REVOKED,
    now: Date,
  ): Promise<boolean> {
    const { count } = await this.db.workspaceInvitation.updateMany({
      where: { id: invitationId, status: InvitationStatus.PENDING, expiresAt: { gt: now } },
      data: { status: to },
    });
    return count === 1;
  }

  async markExpired(invitationId: string, now: Date): Promise<void> {
    await this.db.workspaceInvitation.updateMany({
      where: { id: invitationId, status: InvitationStatus.PENDING, expiresAt: { lte: now } },
      data: { status: InvitationStatus.EXPIRED },
    });
  }
}
