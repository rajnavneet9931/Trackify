import { Prisma } from '../../generated/prisma/client.js';
import type { DatabaseClient } from '../../infrastructure/database/prisma.js';
import { recordTaskActivities, TaskActivityType } from '../activities/index.js';
import {
  WorkspaceRole,
  workspaceSettingsSelect,
  workspaceSummarySelect,
  type Membership,
  type WorkspaceListItem,
  type WorkspaceSettings,
  type WorkspaceSettingsChanges,
  type WorkspaceSummary,
} from './workspace.model.js';

export interface NewWorkspace {
  name: string;
  /** Always the authenticated user; never taken from request input. */
  ownerId: string;
}

export interface MembershipPageQuery {
  userId: string;
  /** Maximum rows to return. */
  take: number;
  /** Continue strictly after this membership (keyset pagination). */
  afterMembershipId?: string | undefined;
}

/** One row of a user's workspace list; membershipId is the pagination key. */
export interface WorkspaceListRow extends WorkspaceListItem {
  membershipId: string;
}

export interface MemberPageQuery {
  workspaceId: string;
  take: number;
  /** Continue strictly after this membership (keyset pagination). */
  afterMembershipId?: string | undefined;
}

/** One row of a workspace's member list; membershipId is the pagination key. */
export interface WorkspaceMemberRow {
  membershipId: string;
  userId: string;
  /** Normalized (lower-case) email. With `name`, the only user fields exposed to co-members. */
  email: string;
  /** The member's optional display name. */
  name: string | null;
  role: WorkspaceRole;
  joinedAt: Date;
}

export interface WorkspaceRepository {
  /**
   * Creates the workspace and the owner's membership in one transaction:
   * either both rows are committed or neither is.
   */
  createWithOwner(
    workspace: NewWorkspace,
  ): Promise<{ workspace: WorkspaceSummary; membership: Membership }>;
  /** The user's membership in the workspace, or null if there is none. */
  findMembership(workspaceId: string, userId: string): Promise<Membership | null>;
  /**
   * The user's memberships, newest first (membership id DESC; UUIDv7 ids are
   * time-ordered and unique, so the order is total and stable).
   */
  listForUser(query: MembershipPageQuery): Promise<WorkspaceListRow[]>;
  /** Public fields of one workspace, or null. Callers must authorize first. */
  findById(workspaceId: string): Promise<WorkspaceSummary | null>;
  /** The workspace's settings, or null. Callers must authorize first. */
  findSettings(workspaceId: string): Promise<WorkspaceSettings | null>;
  /**
   * A workspace's members, oldest membership first (id ASC). Callers must
   * authorize first (WorkspaceAccess.requireMembership).
   */
  listMembers(query: MemberPageQuery): Promise<WorkspaceMemberRow[]>;
  /**
   * Runs `fn` in one transaction that first locks this workspace's row, so all
   * ownership-affecting operations on the workspace (role changes, member
   * removal) execute one at a time. Anything `fn` throws rolls the whole
   * transaction back. If the workspace does not exist, `fn` still runs and sees
   * no memberships (callers then answer 404).
   */
  withOwnershipLock<T>(
    workspaceId: string,
    fn: (locked: LockedWorkspace) => Promise<T>,
  ): Promise<T>;
}

/**
 * Operations on one workspace while its ownership lock is held. Every method
 * is scoped to that workspace: a user's memberships elsewhere are untouchable.
 */
export interface LockedWorkspace {
  findMembership(userId: string): Promise<Membership | null>;
  countOwners(): Promise<number>;
  /** Sets the role of this user's membership in this workspace. False if absent. */
  setRole(userId: string, role: WorkspaceRole): Promise<boolean>;
  /**
   * Deletes this user's membership in this workspace, only if it is a MEMBER,
   * and unassigns them from this workspace's tasks, recording each
   * unassignment in the task's history with `actorId` (the remover) as the
   * actor. Never touches the account, sessions, invitations, other
   * memberships, or assignments in other workspaces.
   */
  deleteMember(userId: string, actorId: string): Promise<boolean>;
  /** This workspace's settings as of now (inside the lock). */
  findSettings(): Promise<WorkspaceSettings | null>;
  /**
   * Updates name and/or description only if `updated_at` still equals
   * `expectedUpdatedAt`; `updated_at` always moves forward. False if stale.
   */
  updateSettings(expectedUpdatedAt: Date, changes: WorkspaceSettingsChanges): Promise<boolean>;
  /**
   * Deletes exactly this workspace row (`WHERE id = <this workspace>`).
   * PostgreSQL's ON DELETE CASCADE then removes everything it owns, in this
   * same transaction: memberships, invitations, projects → tasks → comments,
   * activities, reminders, and notifications. Users, sessions and every other
   * workspace are untouched. False if it was already gone.
   */
  deleteWorkspace(): Promise<boolean>;
}

const BUMP_UPDATED_AT = Prisma.sql`updated_at = GREATEST(date_trunc('milliseconds', clock_timestamp()), updated_at + interval '1 millisecond')`;

/** Bounded wait for row locks inside the ownership transaction (then 503, rolled back). */
const OWNERSHIP_LOCK_TIMEOUT = '5s';
/** Prisma interactive-transaction limits: queue wait, and total transaction time. */
const OWNERSHIP_TX_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;

const membershipSelect = { workspaceId: true, userId: true, role: true } as const;

export class PrismaWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly db: DatabaseClient) {}

  createWithOwner({ name, ownerId }: NewWorkspace) {
    // Two INSERTs inside one transaction; any failure (e.g. FK violation on the
    // user) rolls back the workspace as well.
    return this.db.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: { name },
        select: workspaceSummarySelect,
      });
      const membership = await tx.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: ownerId, role: WorkspaceRole.OWNER },
        select: membershipSelect,
      });
      return { workspace, membership };
    });
  }

  findMembership(workspaceId: string, userId: string): Promise<Membership | null> {
    return this.db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: membershipSelect,
    });
  }

  async listForUser({ userId, take, afterMembershipId }: MembershipPageQuery) {
    // Filters on workspace_members.user_id (indexed) and loads only the needed
    // workspace columns: two statements (page + one IN lookup) for any page size.
    const rows = await this.db.workspaceMember.findMany({
      where: { userId, ...(afterMembershipId && { id: { lt: afterMembershipId } }) },
      orderBy: { id: 'desc' },
      take,
      select: { id: true, role: true, workspace: { select: workspaceSummarySelect } },
    });
    return rows.map(({ id, role, workspace }) => ({ membershipId: id, role, ...workspace }));
  }

  findSettings(workspaceId: string): Promise<WorkspaceSettings | null> {
    return this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: workspaceSettingsSelect,
    });
  }

  findById(workspaceId: string): Promise<WorkspaceSummary | null> {
    return this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: workspaceSummarySelect,
    });
  }

  async listMembers({ workspaceId, take, afterMembershipId }: MemberPageQuery) {
    // Filter served by the (workspace_id, user_id) unique index; user columns
    // are limited to id and email (never password hashes or sessions). Two
    // statements (page + one IN lookup of users) for any page size.
    const rows = await this.db.workspaceMember.findMany({
      where: { workspaceId, ...(afterMembershipId && { id: { gt: afterMembershipId } }) },
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        role: true,
        createdAt: true,
        user: { select: { id: true, email: true, name: true } },
      },
    });
    return rows.map(({ id, role, createdAt, user }) => ({
      membershipId: id,
      userId: user.id,
      email: user.email,
      name: user.name,
      role,
      joinedAt: createdAt,
    }));
  }

  withOwnershipLock<T>(workspaceId: string, fn: (locked: LockedWorkspace) => Promise<T>) {
    return this.db.$transaction(async (tx) => {
      // Bound every lock wait in this transaction; on expiry PostgreSQL raises
      // 55P03, the transaction rolls back and the client gets a 503.
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${OWNERSHIP_LOCK_TIMEOUT}'`);
      // The per-workspace mutex. FOR NO KEY UPDATE conflicts with itself (so
      // ownership changes serialize) but not with the FOR KEY SHARE locks taken
      // by foreign-key checks, so e.g. accepting an invitation is not blocked.
      // Always the first lock taken, and only one per transaction: no deadlocks.
      await tx.$queryRaw`SELECT 1 FROM workspaces WHERE id = ${workspaceId}::uuid FOR NO KEY UPDATE`;

      const scope = (userId: string) => ({ workspaceId_userId: { workspaceId, userId } });
      return fn({
        findMembership: (userId) =>
          tx.workspaceMember.findUnique({ where: scope(userId), select: membershipSelect }),
        countOwners: () =>
          tx.workspaceMember.count({ where: { workspaceId, role: WorkspaceRole.OWNER } }),
        setRole: async (userId, role) =>
          (await tx.workspaceMember.updateMany({ where: { workspaceId, userId }, data: { role } }))
            .count === 1,
        deleteMember: async (userId, actorId) => {
          // Conditional on role as defence in depth: even a writer that bypasses
          // the lock can never get an OWNER deleted here (the WHERE clause is
          // re-checked on the locked row under READ COMMITTED).
          const { count } = await tx.workspaceMember.deleteMany({
            where: { workspaceId, userId, role: WorkspaceRole.MEMBER },
          });
          if (count !== 1) return false;
          // A removed member keeps no task assignments in this workspace (and
          // only this one): unassigned in the same transaction, with
          // updated_at moved forward as for every task change. An assignment
          // that was waiting on this membership row (FOR SHARE) either
          // committed first, and is cleared here, or sees the row gone.
          const unassigned = await tx.$queryRaw<{ id: string }[]>`
            UPDATE tasks
            SET assignee_id = NULL,
                updated_at = GREATEST(date_trunc('milliseconds', clock_timestamp()), updated_at + interval '1 millisecond')
            WHERE assignee_id = ${userId}::uuid
              AND project_id IN (SELECT id FROM projects WHERE workspace_id = ${workspaceId}::uuid)
            RETURNING id`;
          // Each unassignment is in the task's history, attributed to the
          // owner who removed the member, in this same transaction.
          await recordTaskActivities(
            tx,
            actorId,
            unassigned.map(({ id }) => ({
              taskId: id,
              activity: {
                type: TaskActivityType.ASSIGNEE_CHANGED,
                metadata: { from: userId, to: null, reason: 'MEMBER_REMOVED' as const },
              },
            })),
          );
          return true;
        },
        findSettings: () =>
          tx.workspace.findUnique({ where: { id: workspaceId }, select: workspaceSettingsSelect }),
        updateSettings: async (expectedUpdatedAt, { name, description }) => {
          const sets = [BUMP_UPDATED_AT];
          if (name !== undefined) sets.push(Prisma.sql`name = ${name}`);
          if (description !== undefined) sets.push(Prisma.sql`description = ${description}`);
          const count = await tx.$executeRaw`
            UPDATE workspaces SET ${Prisma.join(sets)}
            WHERE id = ${workspaceId}::uuid
              AND updated_at = ${expectedUpdatedAt.toISOString()}::timestamptz`;
          return count === 1;
        },
        deleteWorkspace: async () => {
          // Scoped by primary key to the locked workspace; never a filter that
          // could match another row. The cascade runs inside this transaction.
          const count = await tx.$executeRaw`
            DELETE FROM workspaces WHERE id = ${workspaceId}::uuid`;
          return count === 1;
        },
      });
    }, OWNERSHIP_TX_OPTIONS);
  }
}
