import { ConflictError, NotFoundError } from '../../core/errors/app-error.js';
import { authorizeMembership, type WorkspaceAccess } from './workspace-access.js';
import {
  decodeMemberCursor,
  decodeWorkspaceCursor,
  encodeMemberCursor,
  encodeWorkspaceCursor,
} from './workspace-cursor.js';
import {
  WorkspaceRole,
  type Membership,
  type WorkspaceListItem,
  type WorkspaceSettings,
  type WorkspaceSettingsChanges,
  type WorkspaceSummary,
} from './workspace.model.js';
import type { WorkspaceRepository } from './workspace.repository.js';

export interface CreateWorkspaceInput {
  /** Authenticated user from the server-side session. */
  userId: string;
  name: string;
}

export interface PageInput {
  /** Authenticated user from the server-side session. */
  userId: string;
  limit: number;
  cursor?: string | undefined;
}

export interface Page<T> {
  items: T[];
  /** Opaque token for the next page, or null when this is the last page. */
  nextCursor: string | null;
}

export interface WorkspaceMember {
  userId: string;
  email: string;
  name: string | null;
  role: WorkspaceRole;
  joinedAt: Date;
}

export class WorkspaceService {
  constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly access: WorkspaceAccess,
  ) {}

  /** The creator always becomes the OWNER; no caller can choose another owner or role. */
  create({
    userId,
    name,
  }: CreateWorkspaceInput): Promise<{ workspace: WorkspaceSummary; membership: Membership }> {
    return this.workspaces.createWithOwner({ name, ownerId: userId });
  }

  /**
   * Workspaces the user is a member of. Fetches one extra row to learn whether
   * another page exists, without a separate COUNT query.
   */
  async list({ userId, limit, cursor }: PageInput): Promise<Page<WorkspaceListItem>> {
    const rows = await this.workspaces.listForUser({
      userId,
      take: limit + 1,
      afterMembershipId: cursor === undefined ? undefined : decodeWorkspaceCursor(cursor),
    });

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(({ id, name, createdAt, role }) => ({ id, name, createdAt, role })),
      nextCursor: rows.length > limit && last ? encodeWorkspaceCursor(last.membershipId) : null,
    };
  }

  /**
   * One workspace plus the caller's membership. Non-members and unknown IDs
   * both get 404 (WorkspaceAccess), so existence is never revealed.
   */
  async get(
    workspaceId: string,
    userId: string,
  ): Promise<{ workspace: WorkspaceSummary; membership: Membership }> {
    const membership = await this.access.requireMembership(workspaceId, userId);
    const workspace = await this.workspaces.findById(workspaceId);
    // Deleted between the two reads: indistinguishable from "not found".
    if (!workspace) throw new NotFoundError('Workspace not found');
    return { workspace, membership };
  }

  /** Members of a workspace the caller belongs to, oldest membership first. */
  async listMembers(
    workspaceId: string,
    { userId, limit, cursor }: PageInput,
  ): Promise<Page<WorkspaceMember>> {
    // Authorize before decoding the cursor or reading anything else.
    await this.access.requireMembership(workspaceId, userId);

    const rows = await this.workspaces.listMembers({
      workspaceId,
      take: limit + 1,
      afterMembershipId: cursor === undefined ? undefined : decodeMemberCursor(cursor),
    });

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(({ userId: id, email, name, role, joinedAt }) => ({
        userId: id,
        email,
        name,
        role,
        joinedAt,
      })),
      nextCursor: rows.length > limit && last ? encodeMemberCursor(last.membershipId) : null,
    };
  }

  /**
   * Owner removes a regular MEMBER from this workspace (membership row only).
   * Runs under the workspace ownership lock, so the requester's OWNER role is
   * checked in the same transaction as the delete: a concurrent demotion of
   * the requester cannot slip in between.
   */
  async removeMember(workspaceId: string, requesterId: string, targetUserId: string) {
    await this.workspaces.withOwnershipLock(workspaceId, async (locked) => {
      // 404 outsiders / unknown workspace, 403 non-owners (shared policy).
      authorizeMembership(await locked.findMembership(requesterId), OWNER_ONLY);
      if (targetUserId === requesterId) {
        throw new ConflictError(MEMBER_REMOVAL_MESSAGES.self);
      }

      if (await locked.deleteMember(targetUserId, requesterId)) return;

      const target = await locked.findMembership(targetUserId);
      if (!target) throw new NotFoundError(MEMBER_REMOVAL_MESSAGES.notFound);
      throw new ConflictError(MEMBER_REMOVAL_MESSAGES.owner);
    });
  }

  /**
   * Owner sets another member's role (OWNER ↔ MEMBER). Invariant: a workspace
   * always keeps at least one OWNER. Every check (requester is OWNER, target
   * exists, owner count) and the update happen in one transaction holding the
   * workspace lock, so concurrent changes are applied one after another and
   * each sees the result of the previous one. Setting the current role again
   * is an idempotent no-op (`changed: false`).
   */
  async changeRole(
    workspaceId: string,
    requesterId: string,
    targetUserId: string,
    role: WorkspaceRole,
  ): Promise<{ userId: string; role: WorkspaceRole; changed: boolean }> {
    return this.workspaces.withOwnershipLock(workspaceId, async (locked) => {
      authorizeMembership(await locked.findMembership(requesterId), OWNER_ONLY);

      const target = await locked.findMembership(targetUserId);
      if (!target) throw new NotFoundError(ROLE_CHANGE_MESSAGES.notFound);
      if (target.role === role) return { userId: targetUserId, role, changed: false };

      if (target.role === WorkspaceRole.OWNER && (await locked.countOwners()) <= 1) {
        throw new ConflictError(ROLE_CHANGE_MESSAGES.lastOwner);
      }
      if (!(await locked.setRole(targetUserId, role))) {
        // Unreachable while the lock is held; kept so a bug can't report success.
        throw new NotFoundError(ROLE_CHANGE_MESSAGES.notFound);
      }
      return { userId: targetUserId, role, changed: true };
    });
  }

  /** Any member reads the settings (404 for outsiders and unknown workspaces). */
  async getSettings(
    workspaceId: string,
    userId: string,
  ): Promise<{ settings: WorkspaceSettings; membership: Membership }> {
    const membership = await this.access.requireMembership(workspaceId, userId);
    const settings = await this.workspaces.findSettings(workspaceId);
    if (!settings) throw new NotFoundError('Workspace not found');
    return { settings, membership };
  }

  /**
   * Owners edit the name and/or description. The requester's role is re-read
   * inside the workspace lock (a concurrent demotion is either seen or waits),
   * and the update is conditional on `expectedUpdatedAt` (409 if stale).
   */
  updateSettings(
    workspaceId: string,
    requesterId: string,
    expectedUpdatedAt: Date,
    changes: WorkspaceSettingsChanges,
  ): Promise<{ settings: WorkspaceSettings; membership: Membership }> {
    return this.workspaces.withOwnershipLock(workspaceId, async (locked) => {
      const membership = authorizeMembership(await locked.findMembership(requesterId), OWNER_ONLY);
      if (!(await locked.updateSettings(expectedUpdatedAt, changes))) {
        throw new ConflictError(WORKSPACE_SETTINGS_MESSAGES.stale);
      }
      const settings = await locked.findSettings();
      if (!settings) throw new NotFoundError('Workspace not found');
      return { settings, membership };
    });
  }

  /**
   * Owner permanently deletes the workspace. In one transaction holding the
   * workspace lock: the requester is re-checked as an OWNER of **this**
   * workspace (404 outsiders, 403 members), then exactly this workspace row is
   * deleted and the database cascades to everything it owns. Nothing outside
   * the workspace (users, sessions, other workspaces) is touched.
   */
  async deleteWorkspace(workspaceId: string, requesterId: string): Promise<void> {
    await this.workspaces.withOwnershipLock(workspaceId, async (locked) => {
      authorizeMembership(await locked.findMembership(requesterId), OWNER_ONLY);
      if (!(await locked.deleteWorkspace())) {
        // Unreachable while the lock is held; kept so a bug can't report success.
        throw new NotFoundError('Workspace not found');
      }
    });
  }
}

export const WORKSPACE_SETTINGS_MESSAGES = {
  stale: 'These settings were changed by someone else. Reload them and try again.',
} as const;

const OWNER_ONLY = [WorkspaceRole.OWNER] as const;

export const MEMBER_REMOVAL_MESSAGES = {
  self: 'You cannot remove yourself from the workspace.',
  notFound: 'Member not found',
  owner: 'Workspace owners cannot be removed.',
} as const;

export const ROLE_CHANGE_MESSAGES = {
  notFound: 'Member not found',
  lastOwner: 'A workspace must have at least one owner.',
} as const;
