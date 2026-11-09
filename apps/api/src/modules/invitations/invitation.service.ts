import {
  ConflictError,
  ForbiddenError,
  GoneError,
  NotFoundError,
  UnprocessableEntityError,
} from '../../core/errors/app-error.js';
import { generateOpaqueToken, hashOpaqueToken } from '../../core/security/opaque-token.js';
import { normalizeEmail, type UserDirectory } from '../users/index.js';
import {
  WorkspaceRole,
  type WorkspaceAccess,
  type WorkspaceRepository,
  type WorkspaceSummary,
} from '../workspaces/index.js';
import { effectiveStatus, InvitationStatus, type InvitationView } from './invitation.model.js';
import {
  AlreadyMemberError,
  InvitationNotPendingError,
  PendingInvitationExistsError,
  type InvitationForToken,
  type InvitationRepository,
} from './invitation.repository.js';

const OWNER_ONLY = [WorkspaceRole.OWNER] as const;

export const INVITATION_MESSAGES = {
  notRegistered: 'Only people who already have a Trackify account can be invited.',
  alreadyMember: 'This person is already a member of the workspace.',
  pendingExists: 'A pending invitation already exists for this email address.',
  notFound: 'Invitation not found',
  wrongEmail: 'This invitation was sent to a different email address.',
  expired: 'This invitation has expired.',
  noLongerValid: 'This invitation is no longer valid.',
  onlyPendingRevocable: 'Only pending invitations can be revoked.',
  youAreAlreadyMember: 'You are already a member of this workspace.',
} as const;

export interface CreatedInvitation {
  invitation: InvitationView;
  /** Raw token. Returned to the caller only; never stored or logged. */
  token: string;
}

export interface Invitee {
  id: string;
  /** Normalized email from the server-side session. */
  email: string;
}

export class InvitationService {
  constructor(
    private readonly invitations: InvitationRepository,
    private readonly access: WorkspaceAccess,
    private readonly workspaces: Pick<WorkspaceRepository, 'findMembership'>,
    private readonly users: UserDirectory,
    private readonly ttlMs: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Owner-only. Invites an existing user by email. Non-members get 404 and
   * members without the OWNER role get 403 (WorkspaceAccess).
   */
  async create(workspaceId: string, inviterId: string, email: string): Promise<CreatedInvitation> {
    await this.access.requireMembership(workspaceId, inviterId, OWNER_ONLY);

    const invitee = await this.users.findByEmail(normalizeEmail(email));
    if (!invitee) throw new UnprocessableEntityError(INVITATION_MESSAGES.notRegistered);
    if (await this.workspaces.findMembership(workspaceId, invitee.id)) {
      throw new ConflictError(INVITATION_MESSAGES.alreadyMember);
    }

    const token = generateOpaqueToken();
    const now = this.now();
    try {
      const invitation = await this.invitations.create(
        {
          workspaceId,
          inviterId,
          email: invitee.email,
          tokenHash: hashOpaqueToken(token),
          expiresAt: new Date(now.getTime() + this.ttlMs),
        },
        now,
      );
      return { invitation, token };
    } catch (error) {
      if (error instanceof PendingInvitationExistsError) {
        throw new ConflictError(INVITATION_MESSAGES.pendingExists);
      }
      throw error;
    }
  }

  /** Owner-only status check of one invitation in this workspace. */
  async get(workspaceId: string, invitationId: string, userId: string): Promise<InvitationView> {
    await this.access.requireMembership(workspaceId, userId, OWNER_ONLY);
    return this.findViewOrThrow(workspaceId, invitationId);
  }

  /** Owner-only. PENDING → REVOKED; the token can never be used afterwards. */
  async revoke(workspaceId: string, invitationId: string, userId: string): Promise<InvitationView> {
    await this.access.requireMembership(workspaceId, userId, OWNER_ONLY);
    const invitation = await this.findViewOrThrow(workspaceId, invitationId);
    if (invitation.status !== InvitationStatus.PENDING) {
      throw new ConflictError(INVITATION_MESSAGES.onlyPendingRevocable);
    }
    if (!(await this.invitations.transition(invitationId, InvitationStatus.REVOKED, this.now()))) {
      throw new ConflictError(INVITATION_MESSAGES.onlyPendingRevocable);
    }
    return { ...invitation, status: InvitationStatus.REVOKED };
  }

  /** Invitee: join the workspace as MEMBER. Single-use; exactly one concurrent call wins. */
  async accept(
    token: string,
    invitee: Invitee,
  ): Promise<{ workspace: WorkspaceSummary; role: WorkspaceRole }> {
    const invitation = await this.usableInvitation(token, invitee);
    try {
      return await this.invitations.accept(invitation.id, invitee.id, this.now());
    } catch (error) {
      if (error instanceof AlreadyMemberError) {
        throw new ConflictError(INVITATION_MESSAGES.youAreAlreadyMember);
      }
      if (error instanceof InvitationNotPendingError) throw await this.whyUnusable(token);
      throw error;
    }
  }

  /** Invitee: decline. Single-use like acceptance. */
  async decline(token: string, invitee: Invitee): Promise<void> {
    const invitation = await this.usableInvitation(token, invitee);
    const declined = await this.invitations.transition(
      invitation.id,
      InvitationStatus.DECLINED,
      this.now(),
    );
    if (!declined) throw await this.whyUnusable(token);
  }

  private async findViewOrThrow(workspaceId: string, invitationId: string) {
    const invitation = await this.invitations.findInWorkspace(workspaceId, invitationId);
    if (!invitation) throw new NotFoundError(INVITATION_MESSAGES.notFound);
    return { ...invitation, status: effectiveStatus(invitation, this.now()) };
  }

  /**
   * Checks in a deliberate order: unknown token (404) → wrong account (403,
   * without revealing anything about the invitation) → state (410/409).
   */
  private async usableInvitation(token: string, invitee: Invitee): Promise<InvitationForToken> {
    const invitation = await this.invitations.findByTokenHash(hashOpaqueToken(token));
    if (!invitation) throw new NotFoundError(INVITATION_MESSAGES.notFound);
    if (invitation.email !== normalizeEmail(invitee.email)) {
      throw new ForbiddenError(INVITATION_MESSAGES.wrongEmail);
    }
    const unusable = await this.stateError(invitation);
    if (unusable) throw unusable;
    return invitation;
  }

  /** After losing a race: re-read and explain why the invitation can't be used. */
  private async whyUnusable(token: string) {
    const invitation = await this.invitations.findByTokenHash(hashOpaqueToken(token));
    if (!invitation) return new NotFoundError(INVITATION_MESSAGES.notFound);
    return (
      (await this.stateError(invitation)) ?? new ConflictError(INVITATION_MESSAGES.noLongerValid)
    );
  }

  private async stateError(invitation: InvitationForToken) {
    const now = this.now();
    const status = effectiveStatus(invitation, now);
    if (status === InvitationStatus.PENDING) return null;
    if (status === InvitationStatus.EXPIRED) {
      if (invitation.status === InvitationStatus.PENDING) {
        await this.invitations.markExpired(invitation.id, now);
      }
      return new GoneError(INVITATION_MESSAGES.expired);
    }
    return new ConflictError(INVITATION_MESSAGES.noLongerValid);
  }
}
