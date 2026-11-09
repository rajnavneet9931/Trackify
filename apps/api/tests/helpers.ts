import type { Express } from 'express';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createLogger, type Logger } from '../src/config/logger.js';
import type { DatabaseClient } from '../src/infrastructure/database/prisma.js';
import type { HealthRepository } from '../src/modules/health/health.repository.js';
import type {
  ActiveSession,
  NewSession,
  SessionRepository,
} from '../src/modules/sessions/index.js';
import {
  EmailAlreadyRegisteredError,
  type NewUser,
  type PublicUser,
  type UserCredentials,
  type UserRepository,
} from '../src/modules/users/index.js';
import {
  WorkspaceRole,
  type Membership,
  type MembershipPageQuery,
  type MemberPageQuery,
  type WorkspaceListRow,
  type WorkspaceMemberRow,
  type LockedWorkspace,
  type WorkspaceRepository,
  type WorkspaceSettings,
  type WorkspaceSummary,
} from '../src/modules/workspaces/index.js';
import type {
  InvitationForToken,
  InvitationRepository,
  InvitationStatus,
  InvitationView,
  NewInvitation,
} from '../src/modules/invitations/index.js';
import {
  AlreadyMemberError,
  InvitationNotPendingError,
  PendingInvitationExistsError,
} from '../src/modules/invitations/invitation.repository.js';
import {
  ProjectStatus,
  type NewProject,
  type ProjectDetail,
  type ProjectMutationScope,
  type ProjectPageQuery,
  type ProjectRepository,
  type ProjectView,
} from '../src/modules/projects/index.js';
import {
  TaskStatus,
  type NewTask,
  type TaskDetail,
  type TaskMutationScope,
  type TaskPageQuery,
  type TaskRepository,
  type TaskView,
} from '../src/modules/tasks/index.js';
import { sortValueOf, type TaskFilters } from '../src/modules/tasks/task-query.js';
import type {
  CommentMutationScope,
  CommentPageQuery,
  CommentRepository,
  CommentView,
} from '../src/modules/comments/index.js';
import {
  TaskActivityType,
  type ActivityInput,
  type ActivityPageQuery,
  type ActivityRecord,
  type ActivityRepository,
} from '../src/modules/activities/index.js';
import {
  parseStoredMetadata,
  validatedMetadata,
} from '../src/modules/activities/activity.model.js';
import {
  DEFAULT_SETTINGS,
  type AccountRepository,
  type AccountSettings,
  type Profile,
  type SettingsChanges,
} from '../src/modules/account/index.js';
import {
  NotificationResourceType,
  NotificationType,
  type NotificationInput,
  type NotificationPageQuery,
  type NotificationRepository,
  type NotificationTarget,
  type NotificationView,
} from '../src/modules/notifications/index.js';
import type {
  DashboardBounds,
  DashboardData,
  DashboardRepository,
} from '../src/modules/dashboard/index.js';

interface TestAppOptions {
  databaseUp?: boolean;
  userRepository?: UserRepository;
  sessionRepository?: SessionRepository;
  workspaceRepository?: WorkspaceRepository;
  invitationRepository?: InvitationRepository;
  projectRepository?: ProjectRepository;
  taskRepository?: TaskRepository;
  commentRepository?: CommentRepository;
  activityRepository?: ActivityRepository;
  dashboardRepository?: DashboardRepository;
  notificationRepository?: NotificationRepository;
  accountRepository?: AccountRepository;
  /** Extra environment variables layered over the test defaults. */
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

export function buildTestApp(options: TestAppOptions = {}): Express {
  const config = loadConfig({ ...process.env, ...options.env });
  const healthRepository: HealthRepository = {
    pingDatabase: () =>
      options.databaseUp === false
        ? Promise.reject(new Error('connection refused'))
        : Promise.resolve(),
  };
  const userRepository = options.userRepository ?? new InMemoryUserRepository();
  const users = userRepository instanceof InMemoryUserRepository ? userRepository : undefined;
  const workspaceRepository = options.workspaceRepository ?? new InMemoryWorkspaceRepository(users);
  const workspaces =
    workspaceRepository instanceof InMemoryWorkspaceRepository ? workspaceRepository : undefined;
  const projectRepository =
    options.projectRepository ?? new InMemoryProjectRepository(workspaces, users);
  const activityRepository =
    options.activityRepository ?? new InMemoryActivityRepository(workspaces, users);
  const activities =
    activityRepository instanceof InMemoryActivityRepository ? activityRepository : undefined;
  const sessionRepository = options.sessionRepository ?? new InMemorySessionRepository(users);
  const taskRepository =
    options.taskRepository ??
    new InMemoryTaskRepository(
      projectRepository instanceof InMemoryProjectRepository ? projectRepository : undefined,
      workspaces,
      users,
      activities,
    );

  const notificationRepository =
    options.notificationRepository ??
    new InMemoryNotificationRepository(
      workspaces,
      users,
      taskRepository instanceof InMemoryTaskRepository ? taskRepository : undefined,
      projectRepository instanceof InMemoryProjectRepository ? projectRepository : undefined,
    );

  const accountRepository =
    options.accountRepository ??
    new InMemoryAccountRepository(
      users,
      sessionRepository instanceof InMemorySessionRepository ? sessionRepository : undefined,
      notificationRepository instanceof InMemoryNotificationRepository
        ? notificationRepository
        : undefined,
    );
  if (workspaces && accountRepository instanceof InMemoryAccountRepository) {
    workspaces.nameOf = (userId) => accountRepository.names.get(userId) ?? null;
  }

  return createApp({
    config,
    logger: options.logger ?? createLogger(config),
    // Never touched: every DB-backed dependency is overridden below.
    db: {} as DatabaseClient,
    overrides: {
      healthRepository,
      userRepository,
      sessionRepository,
      workspaceRepository,
      userDirectory: users ?? { findByEmail: async () => null },
      invitationRepository:
        options.invitationRepository ??
        new InMemoryInvitationRepository(
          workspaceRepository instanceof InMemoryWorkspaceRepository
            ? workspaceRepository
            : undefined,
        ),
      projectRepository,
      taskRepository,
      commentRepository:
        options.commentRepository ??
        new InMemoryCommentRepository(
          taskRepository instanceof InMemoryTaskRepository ? taskRepository : undefined,
          workspaces,
          users,
          activities,
        ),
      activityRepository,
      notificationRepository,
      accountRepository,
      dashboardRepository:
        options.dashboardRepository ??
        new InMemoryDashboardRepository(
          taskRepository instanceof InMemoryTaskRepository ? taskRepository : undefined,
          projectRepository instanceof InMemoryProjectRepository ? projectRepository : undefined,
          activities,
          workspaces,
          users,
        ),
    },
  });
}

/** Mimics the database's unique index on email so duplicate handling can be tested. */
export class InMemoryUserRepository implements UserRepository {
  readonly rows: UserCredentials[] = [];

  async create(user: NewUser): Promise<PublicUser> {
    if (this.rows.some((row) => row.email === user.email)) {
      throw new EmailAlreadyRegisteredError();
    }
    const row = { ...user, id: crypto.randomUUID(), createdAt: new Date() };
    this.rows.push(row);
    return { id: row.id, email: row.email, createdAt: row.createdAt };
  }

  async findCredentialsByEmail(email: string): Promise<UserCredentials | null> {
    return this.rows.find((row) => row.email === email) ?? null;
  }

  async findByEmail(email: string): Promise<{ id: string; email: string } | null> {
    const row = this.rows.find((r) => r.email === email);
    return row ? { id: row.id, email: row.email } : null;
  }
}

interface SessionRow extends NewSession {
  id: string;
}

/** Mimics the sessions table: lookup by token hash, expiry filter, replace + cleanup. */
export class InMemorySessionRepository implements SessionRepository {
  readonly rows: SessionRow[] = [];
  lookups = 0;

  constructor(private readonly users?: InMemoryUserRepository) {}

  async replace(session: NewSession, replacedTokenHash?: Uint8Array): Promise<{ id: string }> {
    const now = new Date();
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const row = this.rows[i]!;
      const replaced = replacedTokenHash && sameBytes(row.tokenHash, replacedTokenHash);
      const expired = row.userId === session.userId && row.expiresAt <= now;
      if (replaced || expired) this.rows.splice(i, 1);
    }
    const row = { ...session, id: crypto.randomUUID() };
    this.rows.push(row);
    return { id: row.id };
  }

  async findActive(tokenHash: Uint8Array, now: Date): Promise<ActiveSession | null> {
    this.lookups++;
    const row = this.rows.find((r) => sameBytes(r.tokenHash, tokenHash) && r.expiresAt > now);
    const user = row && this.users?.rows.find((u) => u.id === row.userId);
    if (!row || !user) return null;
    return {
      id: row.id,
      expiresAt: row.expiresAt,
      user: { id: user.id, email: user.email, createdAt: user.createdAt },
    };
  }

  async delete(sessionId: string): Promise<boolean> {
    const index = this.rows.findIndex((row) => row.id === sessionId);
    if (index >= 0) this.rows.splice(index, 1);
    return index >= 0;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Repositories that fail like Prisma does when the database is unreachable. */
export function unreachableDatabaseError(): Error {
  return Object.assign(new Error('Invalid `prisma.user.create()` invocation: secret-host:5432'), {
    name: 'PrismaClientKnownRequestError',
    code: 'P1001',
    meta: { driverAdapterError: { cause: { kind: 'DatabaseNotReachable', host: 'secret-host' } } },
  });
}

export const unreachableUserRepository: UserRepository = {
  create: () => Promise.reject(unreachableDatabaseError()),
  findCredentialsByEmail: () => Promise.reject(unreachableDatabaseError()),
};

export const unreachableSessionRepository: SessionRepository = {
  replace: () => Promise.reject(unreachableDatabaseError()),
  findActive: () => Promise.reject(unreachableDatabaseError()),
  delete: () => Promise.reject(unreachableDatabaseError()),
};

let sequence = 0;
/** Time-ordered UUID-shaped ids, like the UUIDv7 ids Prisma generates. */
function orderedId(): string {
  sequence++;
  return `00000000-0000-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
}

/** Mimics the workspace tables, including the one-membership-per-user unique constraint. */
export class InMemoryWorkspaceRepository implements WorkspaceRepository {
  readonly workspaces: (WorkspaceSummary & { description: string | null; updatedAt: Date })[] = [];
  /** Set by buildTestApp from the account fake: a member's display name. */
  nameOf: (userId: string) => string | null = () => null;
  /**
   * Run after a workspace is deleted, standing in for ON DELETE CASCADE:
   * the project and notification fakes drop that workspace's rows.
   */
  readonly onWorkspaceDeleted: ((workspaceId: string) => void)[] = [];
  readonly members: (Membership & { id: string; createdAt: Date })[] = [];

  /** `users` supplies member emails (like the users table join). */
  constructor(private readonly users?: InMemoryUserRepository) {}

  async createWithOwner({ name, ownerId }: { name: string; ownerId: string }) {
    const now = new Date();
    const workspace = {
      id: crypto.randomUUID(),
      name,
      description: null,
      createdAt: now,
      updatedAt: now,
    };
    const membership = { workspaceId: workspace.id, userId: ownerId, role: WorkspaceRole.OWNER };
    this.workspaces.push(workspace);
    this.members.push({ ...membership, id: orderedId(), createdAt: now });
    return {
      workspace: { id: workspace.id, name: workspace.name, createdAt: workspace.createdAt },
      membership,
    };
  }

  /** Set by an InMemoryTaskRepository: unassigns the removed member's tasks. */
  onMemberRemoved: (workspaceId: string, userId: string, actorId: string) => void = () => undefined;

  /** Test-only: adds a membership (there is no API for this yet). */
  addMember(workspaceId: string, userId: string, role: WorkspaceRole = WorkspaceRole.MEMBER) {
    if (this.members.some((m) => m.workspaceId === workspaceId && m.userId === userId)) {
      throw new Error('duplicate membership');
    }
    this.members.push({ id: orderedId(), workspaceId, userId, role, createdAt: new Date() });
  }

  async findMembership(workspaceId: string, userId: string): Promise<Membership | null> {
    const row = this.members.find((m) => m.workspaceId === workspaceId && m.userId === userId);
    return row ? { workspaceId: row.workspaceId, userId: row.userId, role: row.role } : null;
  }

  async listForUser({
    userId,
    take,
    afterMembershipId,
  }: MembershipPageQuery): Promise<WorkspaceListRow[]> {
    return this.members
      .filter((m) => m.userId === userId && (!afterMembershipId || m.id < afterMembershipId))
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, take)
      .map((m) => {
        const w = this.workspaces.find((x) => x.id === m.workspaceId)!;
        return { membershipId: m.id, role: m.role, id: w.id, name: w.name, createdAt: w.createdAt };
      });
  }

  async findById(workspaceId: string): Promise<WorkspaceSummary | null> {
    const w = this.workspaces.find((x) => x.id === workspaceId);
    return w ? { id: w.id, name: w.name, createdAt: w.createdAt } : null;
  }

  async findSettings(workspaceId: string): Promise<WorkspaceSettings | null> {
    const w = this.workspaces.find((x) => x.id === workspaceId);
    return w ? { ...w } : null;
  }

  async listMembers({
    workspaceId,
    take,
    afterMembershipId,
  }: MemberPageQuery): Promise<WorkspaceMemberRow[]> {
    return this.members
      .filter(
        (m) => m.workspaceId === workspaceId && (!afterMembershipId || m.id > afterMembershipId),
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, take)
      .map((m) => ({
        membershipId: m.id,
        userId: m.userId,
        email: this.users?.rows.find((u) => u.id === m.userId)?.email ?? `${m.userId}@unknown.test`,
        name: this.nameOf(m.userId),
        role: m.role,
        joinedAt: m.createdAt,
      }));
  }

  private lockChain = Promise.resolve();

  /**
   * Same contract as the database version: calls run one at a time (like the
   * workspace row lock) and a thrown error restores the previous state (like a
   * transaction rollback).
   */
  withOwnershipLock<T>(
    workspaceId: string,
    fn: (locked: LockedWorkspace) => Promise<T>,
  ): Promise<T> {
    const run = async () => {
      const snapshot = this.members.map((m) => ({ ...m }));
      const workspaceSnapshot = this.workspaces.map((w) => ({ ...w }));
      const find = (userId: string) =>
        this.members.find((m) => m.workspaceId === workspaceId && m.userId === userId);
      try {
        return await fn({
          findMembership: async (userId) => {
            const m = find(userId);
            return m ? { workspaceId: m.workspaceId, userId: m.userId, role: m.role } : null;
          },
          countOwners: async () =>
            this.members.filter(
              (m) => m.workspaceId === workspaceId && m.role === WorkspaceRole.OWNER,
            ).length,
          setRole: async (userId, role) => {
            const m = find(userId);
            if (m) m.role = role;
            return Boolean(m);
          },
          deleteMember: async (userId, actorId) => {
            const m = find(userId);
            if (!m || m.role !== WorkspaceRole.MEMBER) return false;
            this.members.splice(this.members.indexOf(m), 1);
            this.onMemberRemoved(workspaceId, userId, actorId);
            return true;
          },
          findSettings: () => this.findSettings(workspaceId),
          updateSettings: async (expectedUpdatedAt, { name, description }) => {
            const w = this.workspaces.find((x) => x.id === workspaceId);
            if (!w || w.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return false;
            if (name !== undefined) w.name = name;
            if (description !== undefined) w.description = description;
            w.updatedAt = new Date(Math.max(Date.now(), w.updatedAt.getTime() + 1));
            return true;
          },
          deleteWorkspace: async () => {
            const index = this.workspaces.findIndex((x) => x.id === workspaceId);
            if (index < 0) return false;
            this.workspaces.splice(index, 1);
            for (let i = this.members.length - 1; i >= 0; i--) {
              if (this.members[i]!.workspaceId === workspaceId) this.members.splice(i, 1);
            }
            for (const handler of this.onWorkspaceDeleted) handler(workspaceId);
            return true;
          },
        });
      } catch (error) {
        this.members.splice(0, this.members.length, ...snapshot);
        this.workspaces.splice(0, this.workspaces.length, ...workspaceSnapshot);
        throw error;
      }
    };
    const result = this.lockChain.then(run, run);
    this.lockChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export const unreachableWorkspaceRepository: WorkspaceRepository = {
  createWithOwner: () => Promise.reject(unreachableDatabaseError()),
  findMembership: () => Promise.reject(unreachableDatabaseError()),
  listForUser: () => Promise.reject(unreachableDatabaseError()),
  findById: () => Promise.reject(unreachableDatabaseError()),
  findSettings: () => Promise.reject(unreachableDatabaseError()),
  listMembers: () => Promise.reject(unreachableDatabaseError()),
  withOwnershipLock: () => Promise.reject(unreachableDatabaseError()),
};

type InvitationRow = NewInvitation & {
  id: string;
  status: InvitationStatus;
  createdAt: Date;
};

/**
 * Mimics workspace_invitations: unique token hash, the one-PENDING partial
 * unique index, conditional status transitions, and acceptance that adds the
 * MEMBER row to the in-memory workspace repository (or nothing at all).
 */
export class InMemoryInvitationRepository implements InvitationRepository {
  readonly rows: InvitationRow[] = [];

  constructor(private readonly workspaces?: InMemoryWorkspaceRepository) {}

  async create(invitation: NewInvitation, now: Date): Promise<InvitationView> {
    for (const row of this.rows) {
      if (
        row.workspaceId === invitation.workspaceId &&
        row.email === invitation.email &&
        row.status === 'PENDING' &&
        row.expiresAt <= now
      ) {
        row.status = 'EXPIRED';
      }
    }
    if (
      this.rows.some(
        (r) =>
          r.workspaceId === invitation.workspaceId &&
          r.email === invitation.email &&
          r.status === 'PENDING',
      )
    ) {
      throw new PendingInvitationExistsError();
    }
    const row: InvitationRow = {
      ...invitation,
      id: orderedId(),
      status: 'PENDING',
      createdAt: now,
    };
    this.rows.push(row);
    return this.view(row);
  }

  async findInWorkspace(workspaceId: string, invitationId: string) {
    const row = this.rows.find((r) => r.id === invitationId && r.workspaceId === workspaceId);
    return row ? this.view(row) : null;
  }

  async findByTokenHash(tokenHash: Uint8Array): Promise<InvitationForToken | null> {
    const row = this.rows.find((r) => sameBytes(r.tokenHash, tokenHash));
    return row
      ? {
          id: row.id,
          workspaceId: row.workspaceId,
          email: row.email,
          status: row.status,
          expiresAt: row.expiresAt,
        }
      : null;
  }

  async accept(invitationId: string, userId: string, now: Date) {
    const row = this.rows.find((r) => r.id === invitationId);
    if (!row || row.status !== 'PENDING' || row.expiresAt <= now)
      throw new InvitationNotPendingError();
    if (
      this.workspaces?.members.some((m) => m.workspaceId === row.workspaceId && m.userId === userId)
    ) {
      throw new AlreadyMemberError(); // nothing changed: "rolled back"
    }
    row.status = 'ACCEPTED';
    this.workspaces?.addMember(row.workspaceId, userId, WorkspaceRole.MEMBER);
    const workspace = (await this.workspaces?.findById(row.workspaceId)) ?? {
      id: row.workspaceId,
      name: 'Workspace',
      createdAt: now,
    };
    return { workspace, role: WorkspaceRole.MEMBER };
  }

  async transition(invitationId: string, to: 'DECLINED' | 'REVOKED', now: Date) {
    const row = this.rows.find((r) => r.id === invitationId);
    if (!row || row.status !== 'PENDING' || row.expiresAt <= now) return false;
    row.status = to;
    return true;
  }

  async markExpired(invitationId: string, now: Date) {
    const row = this.rows.find((r) => r.id === invitationId);
    if (row && row.status === 'PENDING' && row.expiresAt <= now) row.status = 'EXPIRED';
  }

  private view(row: InvitationRow): InvitationView {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      email: row.email,
      status: row.status,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    };
  }
}

export const unreachableInvitationRepository: InvitationRepository = {
  create: () => Promise.reject(unreachableDatabaseError()),
  findInWorkspace: () => Promise.reject(unreachableDatabaseError()),
  findByTokenHash: () => Promise.reject(unreachableDatabaseError()),
  accept: () => Promise.reject(unreachableDatabaseError()),
  transition: () => Promise.reject(unreachableDatabaseError()),
  markExpired: () => Promise.reject(unreachableDatabaseError()),
};

/**
 * Mimics the projects table: server-generated id, status and timestamps,
 * workspace-scoped conditional updates/deletes, updated_at that always moves
 * forward, and a mutation "transaction" that rolls back if `fn` throws. The
 * requester's membership comes from the in-memory workspace repository.
 */
export class InMemoryProjectRepository implements ProjectRepository {
  rows: ProjectView[] = [];
  /** Set by an InMemoryTaskRepository: whether a project still has tasks. */
  hasTasks: (projectId: string) => boolean = () => false;

  constructor(
    private readonly workspaces?: InMemoryWorkspaceRepository,
    private readonly users?: InMemoryUserRepository,
  ) {
    workspaces?.onWorkspaceDeleted.push((workspaceId) => {
      this.rows = this.rows.filter((row) => row.workspaceId !== workspaceId);
    });
  }

  async create(project: NewProject): Promise<ProjectView> {
    const now = new Date();
    const row: ProjectView = {
      ...project,
      id: orderedId(),
      status: ProjectStatus.ACTIVE,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(row);
    return { ...row };
  }

  async listForWorkspace({ workspaceId, take, after }: ProjectPageQuery): Promise<ProjectView[]> {
    const newestFirst = (a: ProjectView, b: ProjectView) =>
      b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    return this.rows
      .filter((row) => row.workspaceId === workspaceId)
      .filter(
        (row) =>
          !after ||
          row.createdAt < after.createdAt ||
          (row.createdAt.getTime() === after.createdAt.getTime() && row.id < after.id),
      )
      .sort(newestFirst)
      .slice(0, take)
      .map((row) => ({ ...row }));
  }

  async findInWorkspace(workspaceId: string, projectId: string): Promise<ProjectDetail | null> {
    const row = this.rows.find((r) => r.id === projectId && r.workspaceId === workspaceId);
    if (!row) return null;
    const isMember = this.workspaces?.members.some(
      (m) => m.workspaceId === workspaceId && m.userId === row.createdById,
    );
    const user = this.users?.rows.find((u) => u.id === row.createdById);
    return { ...row, creator: isMember && user ? { id: user.id, email: user.email } : null };
  }

  async withRequesterLock<T>(
    workspaceId: string,
    userId: string,
    fn: (scope: ProjectMutationScope) => Promise<T>,
  ): Promise<T> {
    const snapshot = this.rows.map((row) => ({ ...row }));
    const member = this.workspaces?.members.find(
      (m) => m.workspaceId === workspaceId && m.userId === userId,
    );
    const inScope = (projectId: string) =>
      this.rows.find((r) => r.id === projectId && r.workspaceId === workspaceId);
    const bump = (row: ProjectView) => {
      row.updatedAt = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));
    };
    try {
      return await fn({
        membership: member ? { workspaceId, userId, role: member.role } : null,
        find: async (projectId) => {
          const row = inScope(projectId);
          return row ? { ...row } : null;
        },
        update: async (projectId, expectedUpdatedAt, { name, description }) => {
          const row = inScope(projectId);
          if (
            !row ||
            row.status !== ProjectStatus.ACTIVE ||
            row.updatedAt.getTime() !== expectedUpdatedAt.getTime()
          ) {
            return false;
          }
          if (name !== undefined) row.name = name;
          if (description !== undefined) row.description = description;
          bump(row);
          return true;
        },
        setStatus: async (projectId, from, to) => {
          const row = inScope(projectId);
          if (!row || row.status !== from) return false;
          row.status = to;
          bump(row);
          return true;
        },
        delete: async (projectId) => {
          if (!inScope(projectId)) return 'not-found';
          if (this.hasTasks(projectId)) return 'has-tasks';
          this.rows = this.rows.filter((r) => r.id !== projectId);
          return 'deleted';
        },
      });
    } catch (error) {
      this.rows = snapshot; // "rolled back"
      throw error;
    }
  }
}

export const unreachableProjectRepository: ProjectRepository = {
  create: () => Promise.reject(unreachableDatabaseError()),
  listForWorkspace: () => Promise.reject(unreachableDatabaseError()),
  findInWorkspace: () => Promise.reject(unreachableDatabaseError()),
  withRequesterLock: () => Promise.reject(unreachableDatabaseError()),
};

/**
 * Mimics the tasks table and the task mutation transaction: project lookups
 * scoped to the workspace (from the in-memory project repository), the
 * requester's membership (from the in-memory workspace repository),
 * conditional updates on updated_at (which always moves forward), and
 * rollback if `fn` throws. Registers itself so project deletion sees tasks.
 */
export class InMemoryTaskRepository implements TaskRepository {
  rows: TaskView[] = [];
  /** Set by an InMemoryNotificationRepository (also used by the comment fake). */
  notifications?: InMemoryNotificationRepository;
  /** Scheduled reminders (the real table is task_reminders). */
  reminders: {
    id: string;
    taskId: string;
    remindAt: Date;
    status: 'PENDING' | 'SENT' | 'FAILED' | 'CANCELLED';
    sentAt: Date | null;
  }[] = [];

  constructor(
    private readonly projects?: InMemoryProjectRepository,
    private readonly workspaces?: InMemoryWorkspaceRepository,
    private readonly users?: InMemoryUserRepository,
    private readonly activities?: InMemoryActivityRepository,
  ) {
    if (activities) activities.tasks = this;
    if (projects)
      projects.hasTasks = (projectId) => this.rows.some((t) => t.projectId === projectId);
    if (workspaces) {
      // Mirrors the removal transaction: unassign the member in that workspace only.
      workspaces.onMemberRemoved = (workspaceId, userId, actorId) => {
        const inWorkspace = new Set(
          (this.projects?.rows ?? []).filter((p) => p.workspaceId === workspaceId).map((p) => p.id),
        );
        for (const row of this.rows) {
          if (row.assigneeId === userId && inWorkspace.has(row.projectId)) {
            row.assigneeId = null;
            row.assignee = null;
            row.updatedAt = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));
            this.activities?.record(row.id, actorId, {
              type: TaskActivityType.ASSIGNEE_CHANGED,
              metadata: { from: userId, to: null, reason: 'MEMBER_REMOVED' },
            });
          }
        }
      };
    }
  }

  /** The project of this workspace, if any (also used by InMemoryCommentRepository). */
  project(workspaceId: string, projectId: string) {
    return this.projects?.rows.find((p) => p.id === projectId && p.workspaceId === workspaceId);
  }

  async findProjectStatus(workspaceId: string, projectId: string) {
    return this.project(workspaceId, projectId)?.status ?? null;
  }

  async listForProject({
    projectId,
    take,
    filters,
    sort,
    now,
    after,
  }: TaskPageQuery): Promise<TaskView[]> {
    // Same semantics as task-query.ts: AND of filters, sort value then id
    // (both in the sort direction), tasks without a due date last.
    const key = (row: TaskView) => sortValueOf(row, sort.field);
    const compare = (a: string | null, b: string | null) => {
      if (a === b) return 0;
      if (a === null) return 1; // nulls last, whatever the direction
      if (b === null) return -1;
      const cmp =
        sort.field === 'priority'
          ? PRIORITY_RANK.indexOf(a) - PRIORITY_RANK.indexOf(b)
          : sort.field === 'title'
            ? a < b
              ? -1
              : 1
            : Date.parse(a) - Date.parse(b);
      return sort.order === 'asc' ? cmp : -cmp;
    };
    const order = (a: TaskView, b: TaskView) =>
      compare(key(a), key(b)) ||
      (sort.order === 'asc' ? (a.id < b.id ? -1 : 1) : a.id < b.id ? 1 : -1);
    const isAfter = (row: TaskView) => {
      if (!after) return true;
      const c = compare(key(row), after.value);
      return c > 0 || (c === 0 && (sort.order === 'asc' ? row.id > after.id : row.id < after.id));
    };
    return this.rows
      .filter((row) => row.projectId === projectId && matchesTaskFilters(row, filters, now))
      .filter(isAfter)
      .sort(order)
      .slice(0, take)
      .map((row) => ({ ...row }));
  }

  async countForProject(projectId: string, filters: TaskFilters, now: Date) {
    return this.rows.filter((r) => r.projectId === projectId && matchesTaskFilters(r, filters, now))
      .length;
  }

  async findInProject(
    workspaceId: string,
    projectId: string,
    taskId: string,
  ): Promise<TaskDetail | null> {
    if (!this.project(workspaceId, projectId)) return null;
    const row = this.rows.find((t) => t.id === taskId && t.projectId === projectId);
    if (!row) return null;
    const isMember = this.workspaces?.members.some(
      (m) => m.workspaceId === workspaceId && m.userId === row.createdById,
    );
    const user = this.users?.rows.find((u) => u.id === row.createdById);
    const latest = this.reminders.filter((r) => r.taskId === taskId).at(-1);
    return {
      ...row,
      creator: isMember && user ? { id: user.id, email: user.email } : null,
      reminder: latest
        ? { status: latest.status, remindAt: latest.remindAt, sentAt: latest.sentAt }
        : null,
    };
  }

  async withProjectLock<T>(
    workspaceId: string,
    projectId: string,
    userId: string,
    fn: (scope: TaskMutationScope) => Promise<T>,
  ): Promise<T> {
    const snapshot = this.rows.map((row) => ({ ...row }));
    const reminderSnapshot = this.reminders.map((r) => ({ ...r }));
    const activitySnapshot = this.activities?.snapshot();
    const notificationSnapshot = this.notifications?.snapshot();
    const member = this.workspaces?.members.find(
      (m) => m.workspaceId === workspaceId && m.userId === userId,
    );
    const inScope = (taskId: string) =>
      this.rows.find((t) => t.id === taskId && t.projectId === projectId);
    try {
      return await fn({
        membership: member ? { workspaceId, userId, role: member.role } : null,
        projectStatus: member ? (this.project(workspaceId, projectId)?.status ?? null) : null,
        create: async ({
          title,
          description,
          priority,
          status,
          assigneeId,
          dueDate,
          reminderAt,
        }: NewTask) => {
          const now = new Date();
          const assignee = assigneeId
            ? this.users?.rows.find((u) => u.id === assigneeId)
            : undefined;
          const row: TaskView = {
            id: orderedId(),
            projectId,
            title,
            description,
            priority,
            status: status ?? TaskStatus.TODO,
            createdById: userId,
            assigneeId: assigneeId ?? null,
            assignee: assignee ? { id: assignee.id, email: assignee.email } : null,
            dueDate,
            reminderAt,
            createdAt: now,
            updatedAt: now,
          };
          this.rows.push(row);
          return { ...row };
        },
        lock: async (taskId) => {
          const row = inScope(taskId);
          return row ? { ...row } : null;
        },
        record: async (taskId, activity) => {
          this.activities?.record(taskId, userId, activity);
        },
        find: async (taskId) => {
          const row = inScope(taskId);
          return row ? { ...row } : null;
        },
        update: async (taskId, expectedUpdatedAt, changes) => {
          const row = inScope(taskId);
          if (!row || row.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return false;
          if (changes.title !== undefined) row.title = changes.title;
          if (changes.description !== undefined) row.description = changes.description;
          if (changes.status !== undefined) row.status = changes.status;
          if (changes.priority !== undefined) row.priority = changes.priority;
          if (changes.dueDate !== undefined) row.dueDate = changes.dueDate;
          if (changes.reminderAt !== undefined) row.reminderAt = changes.reminderAt;
          row.updatedAt = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));
          return true;
        },
        isWorkspaceMember: async (candidateId) =>
          Boolean(
            this.workspaces?.members.some(
              (m) => m.workspaceId === workspaceId && m.userId === candidateId,
            ),
          ),
        scheduleReminder: async (taskId, remindAt) => {
          for (const r of this.reminders) {
            if (r.taskId === taskId && r.status === 'PENDING') r.status = 'CANCELLED';
          }
          if (remindAt) {
            this.reminders.push({
              id: orderedId(),
              taskId,
              remindAt,
              status: 'PENDING',
              sentAt: null,
            });
          }
        },
        setAssignee: async (taskId, assigneeId) => {
          const row = inScope(taskId);
          if (!row || row.assigneeId === assigneeId) return false;
          const user = assigneeId ? this.users?.rows.find((u) => u.id === assigneeId) : undefined;
          row.assigneeId = assigneeId;
          row.assignee = user ? { id: user.id, email: user.email } : null;
          row.updatedAt = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));
          return true;
        },
        notify: async (notifications) => {
          this.notifications?.create(workspaceId, userId, notifications);
        },
      });
    } catch (error) {
      this.rows = snapshot; // "rolled back"
      this.reminders = reminderSnapshot;
      if (activitySnapshot) this.activities!.restore(activitySnapshot);
      if (notificationSnapshot) this.notifications!.restore(notificationSnapshot);
      throw error;
    }
  }
}

export const unreachableTaskRepository: TaskRepository = {
  findProjectStatus: () => Promise.reject(unreachableDatabaseError()),
  listForProject: () => Promise.reject(unreachableDatabaseError()),
  countForProject: () => Promise.reject(unreachableDatabaseError()),
  findInProject: () => Promise.reject(unreachableDatabaseError()),
  withProjectLock: () => Promise.reject(unreachableDatabaseError()),
};

type CommentRow = Omit<CommentView, 'author'>;

/**
 * Mimics task_comments and the comment mutation transaction: hierarchy checks
 * via the in-memory task/project/workspace repositories, author emails only
 * for current members, conditional updates on updated_at (always moving
 * forward), and rollback if `fn` throws.
 */
export class InMemoryCommentRepository implements CommentRepository {
  rows: CommentRow[] = [];

  constructor(
    private readonly tasks?: InMemoryTaskRepository,
    private readonly workspaces?: InMemoryWorkspaceRepository,
    private readonly users?: InMemoryUserRepository,
    private readonly activities?: InMemoryActivityRepository,
  ) {}

  private view(workspaceId: string, row: CommentRow): CommentView {
    const isMember = this.workspaces?.members.some(
      (m) => m.workspaceId === workspaceId && m.userId === row.authorId,
    );
    const user = this.users?.rows.find((u) => u.id === row.authorId);
    return { ...row, author: isMember && user ? { id: user.id, email: user.email } : null };
  }

  private taskIn(workspaceId: string, projectId: string, taskId: string) {
    if (!this.tasks?.project(workspaceId, projectId)) return undefined;
    return this.tasks.rows.find((t) => t.id === taskId && t.projectId === projectId);
  }

  async taskExists(workspaceId: string, projectId: string, taskId: string) {
    return this.taskIn(workspaceId, projectId, taskId) !== undefined;
  }

  async listForTask({ workspaceId, taskId, take, after }: CommentPageQuery) {
    const oldestFirst = (a: CommentRow, b: CommentRow) =>
      a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return this.rows
      .filter((row) => row.taskId === taskId)
      .filter(
        (row) =>
          !after ||
          row.createdAt > after.createdAt ||
          (row.createdAt.getTime() === after.createdAt.getTime() && row.id > after.id),
      )
      .sort(oldestFirst)
      .slice(0, take)
      .map((row) => this.view(workspaceId, row));
  }

  async withTaskLock<T>(
    workspaceId: string,
    projectId: string,
    taskId: string,
    userId: string,
    fn: (scope: CommentMutationScope) => Promise<T>,
  ): Promise<T> {
    const snapshot = this.rows.map((row) => ({ ...row }));
    const activitySnapshot = this.activities?.snapshot();
    const notifications = this.tasks?.notifications;
    const notificationSnapshot = notifications?.snapshot();
    const member = this.workspaces?.members.find(
      (m) => m.workspaceId === workspaceId && m.userId === userId,
    );
    const project = member ? this.tasks?.project(workspaceId, projectId) : undefined;
    const task = project ? this.taskIn(workspaceId, projectId, taskId) : undefined;
    const inScope = (commentId: string) =>
      this.rows.find((c) => c.id === commentId && c.taskId === taskId);
    try {
      return await fn({
        membership: member ? { workspaceId, userId, role: member.role } : null,
        projectStatus: project?.status ?? null,
        taskExists: task !== undefined,
        task: task
          ? { title: task.title, assigneeId: task.assigneeId, createdById: task.createdById }
          : null,
        notify: async (inputs) => {
          notifications?.create(workspaceId, userId, inputs);
        },
        create: async (content) => {
          const now = new Date();
          const row: CommentRow = {
            id: orderedId(),
            taskId,
            authorId: userId,
            content,
            createdAt: now,
            updatedAt: now,
          };
          this.rows.push(row);
          return this.view(workspaceId, row);
        },
        lock: async (commentId) => {
          const row = inScope(commentId);
          return row
            ? { authorId: row.authorId, content: row.content, updatedAt: row.updatedAt }
            : null;
        },
        find: async (commentId) => {
          const row = inScope(commentId);
          return row ? this.view(workspaceId, row) : null;
        },
        update: async (commentId, expectedUpdatedAt, content) => {
          const row = inScope(commentId);
          if (
            !row ||
            row.authorId !== userId ||
            row.updatedAt.getTime() !== expectedUpdatedAt.getTime()
          ) {
            return false;
          }
          row.content = content;
          row.updatedAt = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));
          return true;
        },
        record: async (activity) => {
          this.activities?.record(taskId, userId, activity);
        },
        delete: async (commentId) => {
          const before = this.rows.length;
          this.rows = this.rows.filter((c) => !(c.id === commentId && c.taskId === taskId));
          return this.rows.length < before;
        },
      });
    } catch (error) {
      this.rows = snapshot; // "rolled back"
      if (activitySnapshot) this.activities!.restore(activitySnapshot);
      if (notificationSnapshot) notifications!.restore(notificationSnapshot);
      throw error;
    }
  }
}

export const unreachableCommentRepository: CommentRepository = {
  taskExists: () => Promise.reject(unreachableDatabaseError()),
  listForTask: () => Promise.reject(unreachableDatabaseError()),
  withTaskLock: () => Promise.reject(unreachableDatabaseError()),
};

type ActivityRow = {
  id: string;
  taskId: string;
  actorId: string | null;
  type: ActivityRecord['type'];
  metadata: unknown;
  createdAt: Date;
};

/**
 * Mimics task_activities: append-only rows written by the task and comment
 * fakes inside their "transactions" (validated like the real writer, rolled
 * back with them), strictly increasing timestamps, and read-side lookups
 * (hierarchy via the task fake, member emails via the workspace fake).
 */
export class InMemoryActivityRepository implements ActivityRepository {
  rows: ActivityRow[] = [];
  /** Set by InMemoryTaskRepository. */
  tasks?: InMemoryTaskRepository;
  private last = 0;

  constructor(
    private readonly workspaces?: InMemoryWorkspaceRepository,
    private readonly users?: InMemoryUserRepository,
  ) {}

  record(taskId: string, actorId: string, activity: ActivityInput) {
    this.last = Math.max(Date.now(), this.last + 1);
    this.rows.push({
      id: orderedId(),
      taskId,
      actorId,
      type: activity.type,
      metadata: validatedMetadata(activity),
      createdAt: new Date(this.last),
    });
  }

  snapshot() {
    return this.rows.map((row) => ({ ...row }));
  }

  restore(rows: ActivityRow[]) {
    this.rows = rows;
  }

  async taskExists(workspaceId: string, projectId: string, taskId: string) {
    if (!this.tasks?.project(workspaceId, projectId)) return false;
    return this.tasks.rows.some((t) => t.id === taskId && t.projectId === projectId);
  }

  async listForTask({ taskId, take, after }: ActivityPageQuery): Promise<ActivityRecord[]> {
    const oldestFirst = (a: ActivityRow, b: ActivityRow) =>
      a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return this.rows
      .filter((row) => row.taskId === taskId)
      .filter(
        (row) =>
          !after ||
          row.createdAt > after.createdAt ||
          (row.createdAt.getTime() === after.createdAt.getTime() && row.id > after.id),
      )
      .sort(oldestFirst)
      .slice(0, take)
      .map((row) => ({ ...row, metadata: parseStoredMetadata(row.type, row.metadata) }));
  }

  async memberEmails(workspaceId: string, userIds: string[]) {
    const emails = new Map<string, string>();
    for (const id of userIds) {
      const isMember = this.workspaces?.members.some(
        (m) => m.workspaceId === workspaceId && m.userId === id,
      );
      const user = this.users?.rows.find((u) => u.id === id);
      if (isMember && user) emails.set(id, user.email);
    }
    return emails;
  }
}

export const unreachableActivityRepository: ActivityRepository = {
  taskExists: () => Promise.reject(unreachableDatabaseError()),
  listForTask: () => Promise.reject(unreachableDatabaseError()),
  memberEmails: () => Promise.reject(unreachableDatabaseError()),
};

type NotificationRow = Omit<NotificationView, 'actor' | 'target'> & {
  recipientId: string;
  eventKey: string;
};

/**
 * Mimics the notifications table and its writer (notification-writer.ts):
 * self-notifications dropped, one row per (recipient, event key), only current
 * members, rolled back with the fake transaction that created them. Reads
 * are scoped to the recipient and to workspaces they still belong to, and
 * resolve targets through the task/project fakes.
 */
export class InMemoryNotificationRepository implements NotificationRepository {
  rows: NotificationRow[] = [];
  /** Set by an InMemoryAccountRepository: the types a user turned off. */
  mutedTypes: (userId: string) => Set<NotificationType> = () => new Set();
  private last = 0;

  constructor(
    private readonly workspaces?: InMemoryWorkspaceRepository,
    private readonly users?: InMemoryUserRepository,
    private readonly tasks?: InMemoryTaskRepository,
    private readonly projects?: InMemoryProjectRepository,
  ) {
    if (tasks) tasks.notifications = this;
    workspaces?.onWorkspaceDeleted.push((workspaceId) => {
      this.rows = this.rows.filter((row) => row.workspaceId !== workspaceId);
    });
  }

  private isMember(workspaceId: string, userId: string) {
    return (
      this.workspaces?.members.some((m) => m.workspaceId === workspaceId && m.userId === userId) ??
      false
    );
  }

  create(workspaceId: string, actorId: string | null, inputs: NotificationInput[]) {
    for (const n of inputs) {
      if (n.recipientId === actorId || !this.isMember(workspaceId, n.recipientId)) continue;
      if (this.mutedTypes(n.recipientId).has(n.type)) continue;
      if (this.rows.some((r) => r.recipientId === n.recipientId && r.eventKey === n.eventKey)) {
        continue; // ON CONFLICT DO NOTHING
      }
      this.last = Math.max(Date.now(), this.last + 1);
      this.rows.push({
        id: orderedId(),
        recipientId: n.recipientId,
        workspaceId,
        actorId,
        type: n.type,
        title: n.title,
        message: n.message,
        resourceType: n.resourceType,
        resourceId: n.resourceId,
        eventKey: n.eventKey,
        isRead: false,
        readAt: null,
        createdAt: new Date(this.last),
      });
    }
  }

  snapshot() {
    return this.rows.map((row) => ({ ...row }));
  }

  restore(rows: NotificationRow[]) {
    this.rows = rows;
  }

  private visible(userId: string) {
    const muted = this.mutedTypes(userId);
    return this.rows.filter(
      (r) => r.recipientId === userId && this.isMember(r.workspaceId, userId) && !muted.has(r.type),
    );
  }

  private view(row: NotificationRow): NotificationView {
    const { recipientId: _recipient, eventKey: _event, ...rest } = row;
    let target: NotificationTarget | null = null;
    if (row.resourceType === NotificationResourceType.TASK) {
      const task = this.tasks?.rows.find((t) => t.id === row.resourceId);
      if (task && this.tasks?.project(row.workspaceId, task.projectId)) {
        target = { workspaceId: row.workspaceId, projectId: task.projectId, taskId: task.id };
      }
    } else if (row.resourceType === NotificationResourceType.PROJECT) {
      const project = this.projects?.rows.find(
        (p) => p.id === row.resourceId && p.workspaceId === row.workspaceId,
      );
      if (project) target = { workspaceId: row.workspaceId, projectId: project.id, taskId: null };
    } else if (row.resourceId === row.workspaceId) {
      target = { workspaceId: row.workspaceId, projectId: null, taskId: null };
    }
    const actor = row.actorId ? this.users?.rows.find((u) => u.id === row.actorId) : undefined;
    return {
      ...rest,
      actor:
        actor && this.isMember(row.workspaceId, actor.id)
          ? { id: actor.id, email: actor.email }
          : null,
      target,
    };
  }

  async listForUser(userId: string, { take, unreadOnly, after }: NotificationPageQuery) {
    const newestFirst = (a: NotificationRow, b: NotificationRow) =>
      b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    return this.visible(userId)
      .filter((r) => !unreadOnly || !r.isRead)
      .filter(
        (r) =>
          !after ||
          r.createdAt < after.createdAt ||
          (r.createdAt.getTime() === after.createdAt.getTime() && r.id < after.id),
      )
      .sort(newestFirst)
      .slice(0, take)
      .map((r) => this.view(r));
  }

  async countUnread(userId: string) {
    return this.visible(userId).filter((r) => !r.isRead).length;
  }

  async markRead(userId: string, id: string) {
    const row = this.visible(userId).find((r) => r.id === id);
    if (!row) return null;
    if (!row.isRead) {
      row.isRead = true;
      row.readAt = new Date();
    }
    return this.view(row);
  }

  async markAllRead(userId: string) {
    const unread = this.visible(userId).filter((r) => !r.isRead);
    const now = new Date();
    for (const row of unread) {
      row.isRead = true;
      row.readAt = now;
    }
    return unread.length;
  }

  async delete(userId: string, id: string) {
    const row = this.visible(userId).find((r) => r.id === id);
    if (!row) return false;
    this.rows = this.rows.filter((r) => r !== row);
    return true;
  }
}

export const unreachableNotificationRepository: NotificationRepository = {
  listForUser: () => Promise.reject(unreachableDatabaseError()),
  countUnread: () => Promise.reject(unreachableDatabaseError()),
  markRead: () => Promise.reject(unreachableDatabaseError()),
  markAllRead: () => Promise.reject(unreachableDatabaseError()),
  delete: () => Promise.reject(unreachableDatabaseError()),
};

/**
 * Mimics the account side of the users table and user_settings: display names,
 * the conditional password replacement that also deletes every session of the
 * user, and settings with defaults until the first save. Feeds the
 * notification fake's muted types.
 */
export class InMemoryAccountRepository implements AccountRepository {
  readonly names = new Map<string, string | null>();
  readonly settings = new Map<string, AccountSettings>();

  constructor(
    private readonly users?: InMemoryUserRepository,
    private readonly sessions?: InMemorySessionRepository,
    notifications?: InMemoryNotificationRepository,
  ) {
    if (notifications) {
      notifications.mutedTypes = (userId) => {
        const prefs = this.settings.get(userId)?.notifications;
        const muted = new Set<NotificationType>();
        if (prefs?.taskAssigned === false) muted.add(NotificationType.TASK_ASSIGNED);
        if (prefs?.taskCommented === false) muted.add(NotificationType.TASK_COMMENTED);
        if (prefs?.taskReminder === false) muted.add(NotificationType.TASK_REMINDER);
        return muted;
      };
    }
  }

  async findProfile(userId: string): Promise<Profile | null> {
    const user = this.users?.rows.find((u) => u.id === userId);
    return user
      ? {
          id: user.id,
          email: user.email,
          name: this.names.get(userId) ?? null,
          createdAt: user.createdAt,
        }
      : null;
  }

  async updateProfile(userId: string, { name }: { name: string | null }) {
    if (!this.users?.rows.some((u) => u.id === userId)) return null;
    this.names.set(userId, name);
    return this.findProfile(userId);
  }

  async findPasswordHash(userId: string) {
    return this.users?.rows.find((u) => u.id === userId)?.passwordHash ?? null;
  }

  async replacePassword(userId: string, expectedHash: string, newHash: string) {
    const user = this.users?.rows.find((u) => u.id === userId && u.passwordHash === expectedHash);
    if (!user) return false;
    user.passwordHash = newHash;
    if (this.sessions) {
      for (let i = this.sessions.rows.length - 1; i >= 0; i--) {
        if (this.sessions.rows[i]!.userId === userId) this.sessions.rows.splice(i, 1);
      }
    }
    return true;
  }

  async findSettings(userId: string) {
    return structuredClone(this.settings.get(userId) ?? DEFAULT_SETTINGS);
  }

  async updateSettings(userId: string, changes: SettingsChanges) {
    const current = await this.findSettings(userId);
    const next: AccountSettings = {
      timeZone: changes.timeZone !== undefined ? changes.timeZone : current.timeZone,
      dateFormat: changes.dateFormat ?? current.dateFormat,
      notifications: {
        taskAssigned: changes.notifications?.taskAssigned ?? current.notifications.taskAssigned,
        taskCommented: changes.notifications?.taskCommented ?? current.notifications.taskCommented,
        taskReminder: changes.notifications?.taskReminder ?? current.notifications.taskReminder,
      },
    };
    this.settings.set(userId, next);
    return structuredClone(next);
  }
}

export const unreachableAccountRepository: AccountRepository = {
  findProfile: () => Promise.reject(unreachableDatabaseError()),
  updateProfile: () => Promise.reject(unreachableDatabaseError()),
  findPasswordHash: () => Promise.reject(unreachableDatabaseError()),
  replacePassword: () => Promise.reject(unreachableDatabaseError()),
  findSettings: () => Promise.reject(unreachableDatabaseError()),
  updateSettings: () => Promise.reject(unreachableDatabaseError()),
};

/**
 * In-memory version of the dashboard aggregation (dashboard.repository.ts),
 * over the other fakes: task counts and my work over active projects,
 * completion per active project, and the latest workspace activity.
 */
export class InMemoryDashboardRepository implements DashboardRepository {
  constructor(
    private readonly tasks?: InMemoryTaskRepository,
    private readonly projects?: InMemoryProjectRepository,
    private readonly activities?: InMemoryActivityRepository,
    private readonly workspaces?: InMemoryWorkspaceRepository,
    private readonly users?: InMemoryUserRepository,
  ) {}

  async load(workspaceId: string, userId: string, b: DashboardBounds): Promise<DashboardData> {
    const projects = (this.projects?.rows ?? []).filter((p) => p.workspaceId === workspaceId);
    const active = projects.filter((p) => p.status === ProjectStatus.ACTIVE);
    const activeIds = new Set(active.map((p) => p.id));
    const allTasks = this.tasks?.rows ?? [];
    const tasks = allTasks.filter((t) => activeIds.has(t.projectId));
    const open = (t: TaskView) => t.status !== TaskStatus.DONE;
    const due = (t: TaskView, from: Date | null, to: Date) =>
      open(t) && t.dueDate !== null && (!from || t.dueDate >= from) && t.dueDate < to;
    const count = (list: TaskView[], fn: (t: TaskView) => boolean) => list.filter(fn).length;
    const mine = tasks.filter((t) => t.assigneeId === userId);
    const newestFirst = <T extends { createdAt: Date; id: string }>(a: T, z: T) =>
      z.createdAt.getTime() - a.createdAt.getTime() || (a.id < z.id ? 1 : a.id > z.id ? -1 : 0);
    const projectName = new Map(projects.map((p) => [p.id, p.name]));
    const taskById = new Map(allTasks.map((t) => [t.id, t]));

    return {
      tasks: {
        total: tasks.length,
        todo: count(tasks, (t) => t.status === 'TODO'),
        inProgress: count(tasks, (t) => t.status === 'IN_PROGRESS'),
        done: count(tasks, (t) => t.status === 'DONE'),
        low: count(tasks, (t) => t.priority === 'LOW'),
        medium: count(tasks, (t) => t.priority === 'MEDIUM'),
        high: count(tasks, (t) => t.priority === 'HIGH'),
        urgent: count(tasks, (t) => t.priority === 'URGENT'),
        overdue: count(tasks, (t) => due(t, null, b.now)),
        dueToday: count(tasks, (t) => due(t, b.todayStart, b.todayEnd)),
        dueNext7Days: count(tasks, (t) => due(t, b.now, b.weekEnd)),
      },
      myWork: {
        assigned: mine.length,
        pending: count(mine, open),
        overdue: count(mine, (t) => due(t, null, b.now)),
        upcoming: count(mine, (t) => due(t, b.now, b.weekEnd)),
      },
      projects: { active: active.length, archived: projects.length - active.length },
      projectCompletion: [...active]
        .sort(newestFirst)
        .slice(0, 50)
        .map((p) => ({
          id: p.id,
          name: p.name,
          totalTasks: count(tasks, (t) => t.projectId === p.id),
          doneTasks: count(tasks, (t) => t.projectId === p.id && t.status === 'DONE'),
        })),
      myTasks: mine
        .filter(open)
        .sort(
          (a, z) =>
            (a.dueDate?.getTime() ?? Infinity) - (z.dueDate?.getTime() ?? Infinity) ||
            newestFirst(a, z),
        )
        .slice(0, 5)
        .map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          dueDate: t.dueDate,
          projectId: t.projectId,
          projectName: projectName.get(t.projectId)!,
        })),
      recentActivity: (this.activities?.rows ?? [])
        .filter((a) => projectName.has(taskById.get(a.taskId)?.projectId ?? ''))
        .sort(newestFirst)
        .slice(0, 10)
        .map((a) => {
          const task = taskById.get(a.taskId)!;
          const isMember = this.workspaces?.members.some(
            (m) => m.workspaceId === workspaceId && m.userId === a.actorId,
          );
          const user = this.users?.rows.find((u) => u.id === a.actorId);
          return {
            id: a.id,
            type: a.type,
            createdAt: a.createdAt,
            actorId: a.actorId,
            actorEmail: isMember && user ? user.email : null,
            taskId: task.id,
            taskTitle: task.title,
            projectId: task.projectId,
            projectName: projectName.get(task.projectId)!,
          };
        }),
    };
  }
}

export const unreachableDashboardRepository: DashboardRepository = {
  load: () => Promise.reject(unreachableDatabaseError()),
};

const PRIORITY_RANK = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

/** In-memory version of taskListWhere (task-query.ts). */
function matchesTaskFilters(row: TaskView, f: TaskFilters, now: Date): boolean {
  const needle = f.search?.toLowerCase();
  if (
    needle &&
    !row.title.toLowerCase().includes(needle) &&
    !(row.description ?? '').toLowerCase().includes(needle)
  ) {
    return false;
  }
  if (f.status && row.status !== f.status) return false;
  if (f.priority && row.priority !== f.priority) return false;
  if (f.assigneeId && row.assigneeId !== f.assigneeId) return false;
  if (f.unassigned && row.assigneeId !== null) return false;
  if (f.createdById && row.createdById !== f.createdById) return false;
  if (f.dueDate === 'any' && !row.dueDate) return false;
  if (f.dueDate === 'none' && row.dueDate) return false;
  if (f.dueAfter && !(row.dueDate && row.dueDate >= f.dueAfter)) return false;
  if (f.dueBefore && !(row.dueDate && row.dueDate < f.dueBefore)) return false;
  if (f.overdue && !(row.dueDate && row.dueDate < now && row.status !== 'DONE')) return false;
  return true;
}
