import { Prisma } from '../../generated/prisma/client.js';
import type { DatabaseClient } from '../../infrastructure/database/prisma.js';
import type { Membership } from '../workspaces/index.js';
import type { ProjectCursor } from './project-cursor.js';
import {
  ProjectStatus,
  projectViewSelect,
  type ProjectDetail,
  type ProjectView,
} from './project.model.js';

export interface NewProject {
  /** From the validated route parameter, never the body. */
  workspaceId: string;
  /** From the authenticated session, never the body. */
  createdById: string;
  name: string;
  description: string | null;
}

export interface ProjectPageQuery {
  workspaceId: string;
  take: number;
  /** Continue strictly after this position (exclusive). */
  after?: ProjectCursor | undefined;
}

/** Fields an owner may change. `undefined` = leave unchanged; `null` clears the description. */
export interface ProjectChanges {
  name?: string | undefined;
  description?: string | null | undefined;
}

/**
 * Project operations inside one transaction, all scoped to one workspace (a
 * project id from another workspace simply matches nothing).
 */
export interface ProjectMutationScope {
  /** The requester's membership, read FOR SHARE: it cannot change until commit. */
  membership: Membership | null;
  find(projectId: string): Promise<ProjectView | null>;
  /** Only an ACTIVE project whose updated_at equals `expectedUpdatedAt`. False otherwise. */
  update(projectId: string, expectedUpdatedAt: Date, changes: ProjectChanges): Promise<boolean>;
  /** Moves `from` → `to`. False if the project is missing or not in `from`. */
  setStatus(projectId: string, from: ProjectStatus, to: ProjectStatus): Promise<boolean>;
  /**
   * Deletes exactly this project of this workspace, but only while it has no
   * tasks: the project row is locked FOR UPDATE first (which also blocks new
   * task inserts, whose foreign-key check needs a share lock on it), then
   * checked for tasks. A task can therefore never be removed by the
   * project's cascade as a side effect.
   */
  delete(projectId: string): Promise<ProjectDeletion>;
}

export type ProjectDeletion = 'deleted' | 'not-found' | 'has-tasks';

export interface ProjectRepository {
  /** Inserts one ACTIVE project. Callers must authorize first. */
  create(project: NewProject): Promise<ProjectView>;
  /**
   * One page of a workspace's projects, newest first (created_at DESC, id DESC).
   * Callers must authorize first (WorkspaceAccess.requireMembership).
   */
  listForWorkspace(query: ProjectPageQuery): Promise<ProjectView[]>;
  /** One project of this workspace with its creator, or null. Callers must authorize first. */
  findInWorkspace(workspaceId: string, projectId: string): Promise<ProjectDetail | null>;
  /**
   * Runs `fn` in one transaction that first reads the requester's membership
   * of the workspace `FOR SHARE`. A concurrent demotion or removal (an UPDATE
   * or DELETE of that row) therefore waits until this transaction commits, or
   * this one waits and sees the new role: the role checked by `fn` is the role
   * in force when the mutation happens. Anything `fn` throws rolls back.
   */
  withRequesterLock<T>(
    workspaceId: string,
    userId: string,
    fn: (scope: ProjectMutationScope) => Promise<T>,
  ): Promise<T>;
}

/** Bounded lock waits inside mutation transactions (then 503, rolled back). */
const LOCK_TIMEOUT = '5s';
const TX_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;

/**
 * Every mutation moves updated_at strictly forward, computed by PostgreSQL:
 * at least 1 ms past the previous value, even within the same millisecond or
 * with skewed application clocks. So an `expectedUpdatedAt` that was correct
 * before a write can never match after it.
 */
const BUMP_UPDATED_AT = Prisma.sql`updated_at = GREATEST(date_trunc('milliseconds', clock_timestamp()), updated_at + interval '1 millisecond')`;

export class PrismaProjectRepository implements ProjectRepository {
  constructor(private readonly db: DatabaseClient) {}

  create({ workspaceId, createdById, name, description }: NewProject): Promise<ProjectView> {
    return this.db.project.create({
      // Every column set explicitly from server-side values.
      data: { workspaceId, createdById, name, description, status: ProjectStatus.ACTIVE },
      select: projectViewSelect,
    });
  }

  listForWorkspace({ workspaceId, take, after }: ProjectPageQuery): Promise<ProjectView[]> {
    // One statement, served by projects_workspace_id_created_at_id_idx: the
    // workspace filter always applies, and the keyset condition continues
    // after (created_at, id) without offsets.
    return this.db.project.findMany({
      where: {
        workspaceId,
        ...(after && {
          OR: [
            { createdAt: { lt: after.createdAt } },
            { createdAt: after.createdAt, id: { lt: after.id } },
          ],
        }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: projectViewSelect,
    });
  }

  async findInWorkspace(workspaceId: string, projectId: string): Promise<ProjectDetail | null> {
    // The creator's email is shown only while they are a member of this
    // workspace (the same people the member list shows); never anything else
    // from users (no password hash, no sessions).
    const row = await this.db.project.findFirst({
      where: { id: projectId, workspaceId },
      select: {
        ...projectViewSelect,
        createdBy: {
          select: {
            id: true,
            email: true,
            memberships: { where: { workspaceId }, select: { id: true }, take: 1 },
          },
        },
      },
    });
    if (!row) return null;
    const { createdBy, ...project } = row;
    return {
      ...project,
      creator:
        createdBy.memberships.length > 0 ? { id: createdBy.id, email: createdBy.email } : null,
    };
  }

  withRequesterLock<T>(
    workspaceId: string,
    userId: string,
    fn: (scope: ProjectMutationScope) => Promise<T>,
  ): Promise<T> {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      // FOR SHARE conflicts with the row lock that a role change (UPDATE) or a
      // removal (DELETE) takes, but not with other readers. It never touches
      // the workspaces row, so it does not contend with the ownership lock.
      const [membership] = await tx.$queryRaw<{ role: Membership['role'] }[]>`
        SELECT role FROM workspace_members
        WHERE workspace_id = ${workspaceId}::uuid AND user_id = ${userId}::uuid
        FOR SHARE`;

      return fn({
        membership: membership ? { workspaceId, userId, role: membership.role } : null,
        find: (projectId) =>
          tx.project.findFirst({
            where: { id: projectId, workspaceId },
            select: projectViewSelect,
          }),
        update: async (projectId, expectedUpdatedAt, { name, description }) => {
          const sets = [BUMP_UPDATED_AT];
          if (name !== undefined) sets.push(Prisma.sql`name = ${name}`);
          if (description !== undefined) sets.push(Prisma.sql`description = ${description}`);
          const count = await tx.$executeRaw`
            UPDATE projects SET ${Prisma.join(sets)}
            WHERE id = ${projectId}::uuid AND workspace_id = ${workspaceId}::uuid
              AND status = 'ACTIVE'::project_status
              AND updated_at = ${expectedUpdatedAt.toISOString()}::timestamptz`;
          return count === 1;
        },
        setStatus: async (projectId, from, to) => {
          const count = await tx.$executeRaw`
            UPDATE projects SET status = ${to}::project_status, ${BUMP_UPDATED_AT}
            WHERE id = ${projectId}::uuid AND workspace_id = ${workspaceId}::uuid
              AND status = ${from}::project_status`;
          return count === 1;
        },
        delete: async (projectId) => {
          const [locked] = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM projects
            WHERE id = ${projectId}::uuid AND workspace_id = ${workspaceId}::uuid
            FOR UPDATE`;
          if (!locked) return 'not-found';
          const [{ hasTasks }] = await tx.$queryRaw<[{ hasTasks: boolean }]>`
            SELECT EXISTS (SELECT 1 FROM tasks WHERE project_id = ${projectId}::uuid) AS "hasTasks"`;
          if (hasTasks) return 'has-tasks';
          await tx.project.delete({ where: { id: projectId } });
          return 'deleted';
        },
      });
    }, TX_OPTIONS);
  }
}
