import { ConflictError, NotFoundError } from '../../core/errors/app-error.js';
import { authorizeMembership, WorkspaceRole, type WorkspaceAccess } from '../workspaces/index.js';
import { decodeProjectCursor, encodeProjectCursor } from './project-cursor.js';
import { ProjectStatus, type ProjectDetail, type ProjectView } from './project.model.js';
import type {
  ProjectChanges,
  ProjectMutationScope,
  ProjectRepository,
} from './project.repository.js';

export const PROJECT_MESSAGES = {
  notFound: 'Project not found',
  archivedReadOnly: 'Archived projects are read-only. Restore the project to edit it.',
  stale: 'This project was changed by someone else. Reload it to see the latest version.',
  hasTasks:
    'This project still has tasks, so it cannot be deleted. Archive it instead to make it read-only.',
} as const;

export interface UpdateProjectInput extends ProjectChanges {
  /** The `updatedAt` the client last saw (optimistic-concurrency precondition). */
  expectedUpdatedAt: Date;
}

/** Result of archive/restore: `changed: false` when it already had that status. */
export interface StatusChange {
  project: ProjectView;
  changed: boolean;
}

export interface CreateProjectInput {
  name: string;
  description: string | null;
}

export interface ProjectPageInput {
  /** Authenticated user from the server-side session. */
  userId: string;
  limit: number;
  cursor?: string | undefined;
}

export interface ProjectPage {
  items: ProjectView[];
  /** Opaque token for the next page, or null when this is the last page. */
  nextCursor: string | null;
}

const OWNER_ONLY = [WorkspaceRole.OWNER] as const;

export class ProjectService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly access: WorkspaceAccess,
  ) {}

  /**
   * Owner-only for now. Non-members and unknown workspaces get 404, members
   * 403 (WorkspaceAccess). The workspace comes from the route, the creator from
   * the session, and the status is always ACTIVE.
   */
  async create(
    workspaceId: string,
    userId: string,
    { name, description }: CreateProjectInput,
  ): Promise<ProjectView> {
    await this.access.requireMembership(workspaceId, userId, OWNER_ONLY);
    return this.projects.create({ workspaceId, createdById: userId, name, description });
  }

  /** Any member (OWNER or MEMBER) lists the workspace's projects, newest first. */
  async list(
    workspaceId: string,
    { userId, limit, cursor }: ProjectPageInput,
  ): Promise<ProjectPage> {
    // Authorize before decoding the cursor or reading anything else.
    await this.access.requireMembership(workspaceId, userId);

    const rows = await this.projects.listForWorkspace({
      workspaceId,
      take: limit + 1, // one extra row tells whether another page exists
      after: cursor === undefined ? undefined : decodeProjectCursor(cursor),
    });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? encodeProjectCursor(last) : null,
    };
  }

  /** Any member views a project of their workspace, archived or not. */
  async get(workspaceId: string, projectId: string, userId: string): Promise<ProjectDetail> {
    await this.access.requireMembership(workspaceId, userId);
    const project = await this.projects.findInWorkspace(workspaceId, projectId);
    if (!project) throw new NotFoundError(PROJECT_MESSAGES.notFound);
    return project;
  }

  /**
   * Owner edits name/description of an ACTIVE project, only if it still has
   * the `updatedAt` the client saw. Archived → 409 (restore first); changed
   * meanwhile → 409 (reload). Either way nothing is written.
   */
  update(
    workspaceId: string,
    projectId: string,
    userId: string,
    { expectedUpdatedAt, ...changes }: UpdateProjectInput,
  ): Promise<ProjectView> {
    return this.asOwner(workspaceId, userId, async (scope) => {
      const updated = await scope.update(projectId, expectedUpdatedAt, changes);
      const current = await scope.find(projectId);
      if (!current) throw new NotFoundError(PROJECT_MESSAGES.notFound);
      if (!updated) {
        throw new ConflictError(
          current.status === ProjectStatus.ARCHIVED
            ? PROJECT_MESSAGES.archivedReadOnly
            : PROJECT_MESSAGES.stale,
        );
      }
      return current;
    });
  }

  /** Owner archives (ACTIVE → ARCHIVED). Idempotent: already archived → `changed: false`. */
  archive(workspaceId: string, projectId: string, userId: string): Promise<StatusChange> {
    return this.changeStatus(workspaceId, projectId, userId, ProjectStatus.ARCHIVED);
  }

  /** Owner restores (ARCHIVED → ACTIVE). Idempotent: already active → `changed: false`. */
  restore(workspaceId: string, projectId: string, userId: string): Promise<StatusChange> {
    return this.changeStatus(workspaceId, projectId, userId, ProjectStatus.ACTIVE);
  }

  /**
   * Owner permanently deletes one project of this workspace. A repeated or
   * concurrent second delete finds nothing and gets 404. A project that still
   * has tasks is never deleted (409): task data must not disappear as a side
   * effect (there is no task deletion yet; archive the project instead).
   */
  delete(workspaceId: string, projectId: string, userId: string): Promise<void> {
    return this.asOwner(workspaceId, userId, async (scope) => {
      const result = await scope.delete(projectId);
      if (result === 'not-found') throw new NotFoundError(PROJECT_MESSAGES.notFound);
      if (result === 'has-tasks') throw new ConflictError(PROJECT_MESSAGES.hasTasks);
    });
  }

  private changeStatus(
    workspaceId: string,
    projectId: string,
    userId: string,
    to: ProjectStatus,
  ): Promise<StatusChange> {
    const from = to === ProjectStatus.ARCHIVED ? ProjectStatus.ACTIVE : ProjectStatus.ARCHIVED;
    return this.asOwner(workspaceId, userId, async (scope) => {
      const changed = await scope.setStatus(projectId, from, to);
      const project = await scope.find(projectId);
      if (!project) throw new NotFoundError(PROJECT_MESSAGES.notFound);
      return { project, changed };
    });
  }

  /**
   * Runs a mutation with the requester's role re-checked inside the same
   * transaction (membership row read FOR SHARE), so a demotion or removal
   * cannot slip in between the check and the write. Non-members and unknown
   * workspaces → 404, members → 403.
   */
  private asOwner<T>(
    workspaceId: string,
    userId: string,
    fn: (scope: ProjectMutationScope) => Promise<T>,
  ): Promise<T> {
    return this.projects.withRequesterLock(workspaceId, userId, (scope) => {
      authorizeMembership(scope.membership, OWNER_ONLY);
      return fn(scope);
    });
  }
}
